import { t } from '#src/i18n/index';
import { RuntimeContext } from '#src/context';
import { ApplicationError } from '#src/errors';
import type { ApkSigner } from '#src/repositories/apk.repository';
import { ApkRepository, standaloneZwiftPackage } from '#src/repositories/apk.repository';
import { AppReleaseRepository, releaseSources } from '#src/repositories/app-release.repository';
import { CertificateRepository } from '#src/repositories/certificate.repository';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { AssetFiles } from '#src/repositories/files.repository';
import { ToolchainRepository } from '#src/repositories/toolchain.repository';
import { BuildLog } from '#src/repositories/build-log.repository';
import { TlsService } from '#src/services/tls.service';
import { Context, Effect, Layer, Schema } from 'effect';
import { dirname, resolve } from 'node:path';

/** An APKM with Zwift's expansion file is 3 to 5 GB; the limit leaves room for growth. */
export const zwiftAndroidUploadLimit = 10_000_000_000;
/** Small enough to pass proxies such as Cloudflare Tunnel, which cap a request at 100 MB. */
export const zwiftAndroidChunkSize = 16 * 1024 ** 2;
const zwiftObbLimit = 2 * 1024 ** 3;
/**
The free space a build should start with. The saved upload, the patched expansion, the signed app and the app it
replaces hold up to about four copies of the 2 GB expansion at once, besides the upload itself.
*/
export const zwiftAndroidRecommendedSpace = 10_000_000_000;
const originalId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export type ZwiftAndroidStep =
  | 'download'
  | 'extract'
  | 'certificate'
  | 'inspect'
  | 'runtime'
  | 'editor'
  | 'merge'
  | 'decode'
  | 'rename'
  | 'build'
  | 'sign'
  | 'publish';

export interface ZwiftAndroidActivity {
  /** `upload`: the build started when an upload finished; `rebuild`: it started from the saved upload;
  `download`: the server fetched the latest release from APKPure first. */
  readonly kind: 'upload' | 'rebuild' | 'download';
  readonly state: 'running' | 'done' | 'failed';
  readonly steps: ReadonlyArray<ZwiftAndroidStep>;
  readonly step: ZwiftAndroidStep;
  /** The share of the current step that is done, or null when the step cannot tell. */
  readonly progress: number | null;
  readonly message: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/** The app on this server, as zwift.json records it. `certificate` is the fingerprint the expansion trusts. */
const publishedSchema = Schema.Struct({
  versionName: Schema.String,
  versionCode: Schema.Finite,
  bytes: Schema.Finite,
  createdAt: Schema.String,
  certificate: Schema.String,
});

type Published = typeof publishedSchema.Type;

export interface ZwiftAndroidStatus {
  readonly app: {
    readonly versionName: string;
    readonly versionCode: number;
    readonly bytes: number;
    readonly createdAt: string;
    /** False after the server certificate changed: the app no longer connects until it is built again. */
    readonly current: boolean;
  } | null;
}

export interface ZwiftAndroidAdminStatus extends ZwiftAndroidStatus {
  readonly activity: ZwiftAndroidActivity | null;
  /** The last upload, kept unchanged so the app can be built again after a certificate change. */
  readonly original: { readonly name: string; readonly bytes: number; readonly uploadedAt: string } | null;
  readonly tools: { readonly ready: boolean; readonly downloadBytes: number; readonly supported: boolean };
  readonly tlsMode: 'managed' | 'legacy' | 'custom';
  /** Free space on the storage disk, or null when the system does not report it. */
  readonly disk: { readonly free: number | null; readonly recommended: number };
  readonly uploadLimit: number;
  readonly chunkSize: number;
}

interface Upload {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly size: number;
  offset: number;
  readonly workspace: string;
}

const message = (error: unknown) => (error instanceof Error ? error.message : t('zwift_android_build_failed'));

const make = Effect.gen(function* () {
  const { config, world } = yield* RuntimeContext;
  const tls = yield* TlsService;
  const log = world.lifecycle.log;
  const job = new BuildLog(log, 'android', 'Zwift for Android');
  const apk = new ApkRepository();
  const files = new AssetFiles();
  const releases = new AppReleaseRepository();
  const crypto = new CryptoRepository();
  const certificates = new CertificateRepository();
  const folder = resolve(config.storageDir, 'zwift-android');
  const staging = resolve(folder, 'staging');
  const originalsFolder = resolve(folder, 'originals');
  const appPath = resolve(folder, 'zwift-zluggish.apk');
  const metaPath = resolve(folder, 'zwift.json');
  const signerPath = resolve(folder, 'signer.pem');
  // Shared with the Companion patcher, beside storage: the tools can always be downloaded again.
  const toolchain = new ToolchainRepository(resolve(dirname(config.storageDir), 'tools'));

  let activity: ZwiftAndroidActivity | null = null;
  let abort: AbortController | null = null;
  let upload: Upload | undefined;
  let writing = false;
  let stagingReady = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;

  /** A fresh folder for one upload or build. Leftovers from a crash are cleared once per start. */
  async function workspace() {
    if (!stagingReady) {
      await apk.removeTree(staging);
      stagingReady = true;
    }

    return apk.workspace(staging);
  }

  async function published(): Promise<Published | null> {
    const text = await files.readAsync(metaPath);

    if (!text || (await apk.size(appPath)) === null) {
      return null;
    }

    try {
      return Schema.decodeUnknownSync(publishedSchema)(JSON.parse(text.toString('utf8')));
    } catch {
      return null;
    }
  }

  /** The certificate the expansion should trust: the first one the API listener presents. */
  function serverCertificate() {
    const material = tls.material();
    const pem = material && /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(material.cert)?.[0];

    if (tls.mode() === 'legacy') {
      throw new ApplicationError({
        status: 409,
        message: t('zwift_android_shared_certificate_blocked'),
      });
    }

    if (!pem) {
      throw new ApplicationError({
        status: 409,
        message: t('zwift_android_certificate_unavailable'),
      });
    }

    return { pem: pem + '\n', fingerprint: crypto.certificateFacts(pem).fingerprint256 };
  }

  function fingerprint() {
    try {
      return serverCertificate().fingerprint;
    } catch {
      return null;
    }
  }

  async function readOriginal(id: string) {
    if (!originalId.test(id)) {
      return null;
    }

    const directory = resolve(originalsFolder, id);
    const name = await files.readAsync(resolve(directory, 'name'));
    const info = await files.statAsync(resolve(directory, 'upload'));

    if (!name || !info || info.directory) {
      return null;
    }

    return { id, name: name.toString('utf8'), bytes: info.bytes, uploadedAt: info.modified };
  }

  /** The newest saved upload. Older ones are removed when a new one is saved, but a crash may leave one behind. */
  async function original() {
    const entries = await files.entriesAsync(originalsFolder);
    const saved = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map((entry) => readOriginal(entry.name)),
    );

    return saved.filter((entry) => entry !== null).toSorted((a, b) => b.uploadedAt - a.uploadedAt)[0] ?? null;
  }

  /** Keep the finished upload as the one original, replacing any before it. */
  async function keepOriginal(session: Pick<Upload, 'id' | 'name' | 'workspace'>) {
    const retained = resolve(originalsFolder, session.id);

    try {
      await files.writeDurableAsync(resolve(session.workspace, 'name'), session.name);
      await apk.retainUpload(session.workspace, retained);
    } catch (error) {
      await apk.removeTree(session.workspace).catch(reportCleanupFailure);
      throw error;
    }

    for (const entry of await files.entriesAsync(originalsFolder)) {
      if (entry.name !== session.id) {
        await apk.removeTree(resolve(originalsFolder, entry.name));
      }
    }
    await files.syncDirectoryAsync(originalsFolder);
    await files.syncDirectoryAsync(folder);
    log.info('android.original_retained', 'Saved the original Zwift Android upload', { upload: session.name });

    return resolve(retained, 'upload');
  }

  /** The key that signs every Zwift build from this server. Android updates an app only with the same signature. */
  async function signer(): Promise<ApkSigner> {
    let material = certificates.read(signerPath);
    if (!material) {
      material = await certificates.createApkSigner({
        serverId: crypto.randomBytes(6).toString('hex'),
        years: 50,
        now: new Date(),
      });
      await certificates.write(signerPath, material);
    }

    return {
      key: material.key,
      certificate: Buffer.from(material.cert.replaceAll(/-----[A-Z ]+-----|\s/g, ''), 'base64'),
      publicKey: crypto.certificatePublicKey(material.cert),
    };
  }

  async function status(): Promise<ZwiftAndroidStatus> {
    const app = await published();
    const current = fingerprint();

    return {
      app: app && {
        versionName: app.versionName,
        versionCode: app.versionCode,
        bytes: app.bytes,
        createdAt: app.createdAt,
        current: app.certificate === current,
      },
    };
  }

  async function adminStatus(): Promise<ZwiftAndroidAdminStatus> {
    const [base, saved, tools, free] = await Promise.all([
      status(),
      original(),
      toolchain.state(),
      files.freeBytesAsync(config.storageDir),
    ]);

    return {
      ...base,
      activity,
      original: saved && { name: saved.name, bytes: saved.bytes, uploadedAt: new Date(saved.uploadedAt).toISOString() },
      tools: { ready: !!tools.java && tools.editor, downloadBytes: tools.downloadBytes, supported: tools.supported },
      tlsMode: tls.mode(),
      disk: { free, recommended: zwiftAndroidRecommendedSpace },
      uploadLimit: zwiftAndroidUploadLimit,
      chunkSize: zwiftAndroidChunkSize,
    };
  }

  const idle = () => activity?.state !== 'running' && !writing && !upload;

  function requireIdle() {
    if (!idle()) {
      throw new ApplicationError({
        status: 409,
        message: t('zwift_android_build_busy'),
      });
    }
  }

  function current(owner: string, id: string) {
    if (!upload || upload.owner !== owner || upload.id !== id) {
      throw new ApplicationError({
        status: 404,
        message: t('zwift_android_upload_expired'),
      });
    }

    return upload;
  }

  const sessionStatus = (session: Upload) => ({ id: session.id, offset: session.offset, size: session.size });

  function reportCleanupFailure(error: unknown) {
    log.warn('android.upload_cleanup_failed', 'Could not remove a staged Zwift Android upload', {
      error: message(error),
    });
  }

  /** Drop an upload nobody has added to for half an hour, such as one from a closed browser tab. */
  function expire(session: Upload) {
    clearTimeout(expiry);
    expiry = setTimeout(
      () => {
        if (upload !== session) {
          return;
        }
        if (writing) {
          expire(session);

          return;
        }
        upload = undefined;
        void apk.removeTree(session.workspace).catch(reportCleanupFailure);
      },
      30 * 60 * 1000,
    );
    expiry.unref();
  }

  async function stepsFor(): Promise<Array<ZwiftAndroidStep>> {
    const tools = await toolchain.state();

    return [
      'extract',
      'certificate',
      'inspect',
      ...(tools.java ? [] : (['runtime'] as const)),
      ...(tools.editor ? [] : (['editor'] as const)),
      'merge',
      'decode',
      'rename',
      'build',
      'sign',
      'publish',
    ];
  }

  function begin(kind: ZwiftAndroidActivity['kind'], steps: ReadonlyArray<ZwiftAndroidStep>) {
    const [step] = steps;
    if (!step) {
      throw new Error(t('zwift_android_build_steps_required'));
    }
    abort = new AbortController();
    job.started(kind, steps);
    activity = {
      kind,
      state: 'running',
      steps,
      step,
      progress: null,
      message: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };

    return abort.signal;
  }

  function advance(step: ZwiftAndroidStep, progress: number | null = null) {
    if (!activity) {
      return;
    }
    job.step(step);
    activity = { ...activity, step, progress };
  }

  /** Progress for one step, stored only once a whole percent has passed. */
  function meter(step: ZwiftAndroidStep) {
    advance(step, 0);
    let shown = 0;

    return (fraction: number) => {
      if (fraction - shown < 0.01 && fraction !== 1) {
        return;
      }
      shown = fraction;
      advance(step, fraction);
    };
  }

  function finish(failure?: string) {
    if (!activity) {
      return;
    }

    activity = {
      ...activity,
      state: failure === undefined ? 'done' : 'failed',
      progress: null,
      message: failure ?? null,
      finishedAt: new Date().toISOString(),
    };
    abort = null;
    job.finished(failure);
  }

  /** Turn an APKM into one APK named Zwift for Zluggish, with the patched expansion file inside. */
  async function build(source: string, directory: string, signal: AbortSignal) {
    const { pem, fingerprint: trusted } = serverCertificate();
    const startedAt = performance.now();
    const size = async (path: string) => (await apk.size(path)) ?? 0;
    job.info('build_source', 'Building Zwift for Android from the upload', {
      source,
      bytes: await size(source),
      certificate: trusted,
    });

    const obb = resolve(directory, 'original.obb');
    const filename = await apk.extractZwiftObb(source, obb, zwiftObbLimit, signal, meter('extract'));
    const versionCode = Number(filename.split('.', 2)[1]);
    job.info('obb_extracted', 'Extracted the expansion file from the upload', {
      file: filename,
      versionCode,
      bytes: await size(obb),
    });
    signal.throwIfAborted();

    const expansion = resolve(directory, 'patched.obb');
    await apk.patchZwiftObb(obb, expansion, pem, meter('certificate'));
    job.info('obb_patched', 'Added the server certificate to the expansion file', { bytes: await size(expansion) });
    await files.removeAsync(obb);
    signal.throwIfAborted();

    // Check the app before downloading any tools, so that a wrong upload fails fast.
    advance('inspect');
    const splits = resolve(directory, 'splits');
    const { base, parts } = await apk.extractZwiftApks(source, splits, versionCode, signal);
    job.info('apks_extracted', 'Read the app from the upload', {
      package: base.manifest.packageName,
      versionName: base.manifest.versionName,
      versionCode: base.manifest.versionCode,
      minSdk: base.manifest.minSdk,
      splits: parts.length,
    });
    if (base.manifest.minSdk < 26) {
      throw new Error(t('zwift_android_version_unsupported'));
    }

    let tools = await toolchain.state();
    if (!tools.java || !tools.editor) {
      job.info('installing_tools', 'Downloading the Java tools for the Zwift build', {
        java: tools.java?.version ?? null,
        editor: tools.editor,
        downloadBytes: tools.downloadBytes,
        folder: toolchain.folder,
      });
      await toolchain.install(signal, (step, fraction) => advance(step, fraction));
      tools = await toolchain.state();
    }
    job.info('tools', 'Using these Java tools', {
      java: tools.java?.version ?? null,
      javaSource: tools.java?.source ?? null,
      javaCommand: tools.java?.command ?? null,
      editor: tools.editor,
    });

    advance('merge');
    const options = { cwd: directory, signal };
    const editor = (args: ReadonlyArray<string>) => job.tool('APKEditor', args, () => toolchain.editor(args, options));
    let merged = base.path;
    if (parts.length > 1) {
      merged = resolve(directory, 'merged.apk');
      await editor(['m', '-i', splits, '-o', merged, '-f']);
      job.info('merged', 'Merged the split APKs', { parts: parts.length, bytes: await size(merged) });
    } else {
      job.info('merge_skipped', 'The upload holds one APK, so there is nothing to merge', {});
    }

    advance('decode');
    const decoded = resolve(directory, 'decoded');
    await editor(['d', '-comment-level', 'off', '-i', merged, '-o', decoded, '-f']);
    advance('rename');
    await apk.configureDecodedZwift(decoded, versionCode);
    await apk.configureZwiftPackageLookups(decoded);
    job.info('renamed', 'Renamed the decoded app to Zwift for Zluggish', { package: standaloneZwiftPackage });
    advance('build');
    const rebuilt = resolve(directory, 'renamed.apk');
    await editor(['b', '-i', decoded, '-o', rebuilt, '-f']);
    const renamed = await apk.manifest(rebuilt);
    job.info('rebuilt', 'Rebuilt the app', {
      package: renamed.packageName,
      versionName: renamed.versionName,
      versionCode: renamed.versionCode,
      bytes: await size(rebuilt),
    });
    if (renamed.packageName !== standaloneZwiftPackage || renamed.versionCode !== versionCode) {
      throw new Error(t('zwift_android_build_identity_mismatch'));
    }

    const output = resolve(directory, 'signed.apk');
    await apk.signStandaloneZwift(rebuilt, output, expansion, await signer(), meter('sign'));
    job.info('signed', 'Signed the app with the expansion file inside', { bytes: await size(output) });
    signal.throwIfAborted();

    advance('publish');
    await apk.publish(output, appPath);
    const record: Published = {
      versionName: base.manifest.versionName || String(versionCode),
      versionCode,
      bytes: (await apk.size(appPath)) ?? 0,
      createdAt: new Date().toISOString(),
      certificate: trusted,
    };
    await files.writeDurableAsync(metaPath, JSON.stringify(record, null, 2), true);
    log.info('android.published', 'Published Zwift for Zluggish', {
      version: record.versionName,
      bytes: record.bytes,
      durationMs: Math.round(performance.now() - startedAt),
    });
  }

  /** Run a build in the background. The status reports each step until it finishes or fails. */
  async function run(source: () => Promise<string>, signal: AbortSignal) {
    let directory: string | undefined;

    try {
      const input = await source();
      directory = await workspace();
      await build(input, directory, signal);
      finish();
    } catch (error) {
      const reason = signal.aborted ? t('zwift_android_cancelled_by_admin') : message(error);
      log.warn('android.build_failed', 'Could not build Zwift for Zluggish', { error: reason });
      finish(reason);
    } finally {
      if (directory) {
        await apk.removeTree(directory).catch(reportCleanupFailure);
      }
    }
  }

  async function startRebuild() {
    const saved = await original();
    if (!saved) {
      throw new ApplicationError({
        status: 404,
        message: t('zwift_android_upload_missing'),
      });
    }
    requireIdle();
    const signal = begin('rebuild', await stepsFor());
    log.info('android.rebuild_started', 'Building Zwift for Zluggish from the saved upload', { upload: saved.name });
    void run(() => Promise.resolve(resolve(originalsFolder, saved.id, 'upload')), signal);
  }

  /** Fetch the latest release from APKPure into a new saved upload, then build it like an upload. */
  async function startDownload() {
    requireIdle();
    serverCertificate();
    const signal = begin('download', ['download', ...(await stepsFor())]);

    void run(async () => {
      const release = await releases.apkpure(releaseSources.zwift.packageName, signal);

      if (!release) {
        throw new Error(t('app_release_unavailable', { value1: 'APKPure' }));
      }
      job.info('download_started', 'Downloading Zwift from APKPure', {
        version: release.versionName,
        versionCode: release.versionCode,
        bytes: release.bytes,
        file: release.filename,
      });
      const free = await files.freeBytesAsync(config.storageDir);

      if (release.bytes !== null && free !== null && free < release.bytes) {
        throw new Error(
          t('zwift_android_upload_disk_space_insufficient', {
            value1: Math.floor(free / 1e8) / 10,
            value2: Math.ceil(release.bytes / 1e8) / 10,
          }),
        );
      }
      const session = { id: crypto.randomUUID(), name: release.filename, workspace: await workspace() };

      try {
        const bytes = await releases.download(
          release.url,
          resolve(session.workspace, 'upload'),
          zwiftAndroidUploadLimit,
          signal,
          meter('download'),
        );
        job.info('downloaded', 'Downloaded Zwift from APKPure', { bytes });
      } catch (error) {
        await apk.removeTree(session.workspace).catch(reportCleanupFailure);
        throw error;
      }

      return keepOriginal(session);
    }, signal);
  }

  // After a certificate change, the published app no longer connects: build it again for the new certificate.
  tls.subscribe(() => {
    void (async () => {
      const app = await published();
      if (!app || !idle() || app.certificate === fingerprint()) {
        return;
      }
      await startRebuild();
    })().catch((error: unknown) => {
      log.warn('android.rebuild_skipped', 'Could not rebuild Zwift for Zluggish for the new certificate', {
        error: message(error),
      });
    });
  });

  return {
    status,
    adminStatus,
    async download() {
      const app = await published();

      if (!app || app.certificate !== fingerprint()) {
        return null;
      }

      return { path: appPath, filename: `zwift-${app.versionName.replaceAll(/[^\w.-]/g, '')}-zluggish.apk` };
    },
    /** Start a chunked upload. The browser sends the file in pieces so that one dropped request costs little. */
    async begin(owner: string, name: string, size: number) {
      if (!/\.apkm$/i.test(name)) {
        throw new ApplicationError({
          status: 400,
          message: t('zwift_android_expansion_file_required'),
        });
      }
      if (!Number.isSafeInteger(size) || size < 1 || size > zwiftAndroidUploadLimit) {
        throw new ApplicationError({ status: 400, message: t('zwift_android_upload_size_limit') });
      }
      serverCertificate();
      // The upload alone must fit; the page warns about the room the build needs on top of it.
      const free = await files.freeBytesAsync(config.storageDir);
      if (free !== null && free < size) {
        throw new ApplicationError({
          status: 409,
          message: t('zwift_android_upload_disk_space_insufficient', {
            value1: Math.floor(free / 1e8) / 10,
            value2: Math.ceil(size / 1e8) / 10,
          }),
        });
      }
      if (activity?.state === 'running' || writing) {
        throw new ApplicationError({
          status: 409,
          message: t('zwift_android_build_busy'),
        });
      }

      writing = true;
      try {
        // A newer upload replaces one left behind, such as by a reloaded page.
        if (upload) {
          clearTimeout(expiry);
          await apk.removeTree(upload.workspace).catch(reportCleanupFailure);
          upload = undefined;
        }
        upload = { id: crypto.randomUUID(), owner, name, size, offset: 0, workspace: await workspace() };
        expire(upload);
        log.info('android.upload_started', 'Receiving a Zwift Android upload', { upload: name, bytes: size });

        return sessionStatus(upload);
      } finally {
        writing = false;
      }
    },
    async cancel(owner: string, id: string) {
      const session = current(owner, id);
      if (writing) {
        throw new ApplicationError({
          status: 409,
          message: t('zwift_android_upload_cancellation_blocked'),
        });
      }
      clearTimeout(expiry);
      upload = undefined;
      await apk.removeTree(session.workspace);
    },
    async chunk(owner: string, id: string, offset: number, body: ReadableStream<Uint8Array>) {
      const session = current(owner, id);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > session.offset || writing) {
        throw new ApplicationError({
          status: 409,
          message: t('zwift_android_upload_offset_conflict'),
        });
      }
      if (offset < session.offset) {
        return sessionStatus(session);
      }

      writing = true;
      const file = resolve(session.workspace, 'chunk');
      try {
        const expected = Math.min(zwiftAndroidChunkSize, session.size - offset);
        const bytes = await apk.receive(body, file, expected);
        if (bytes !== expected) {
          throw new Error(t('zwift_android_upload_chunk_incomplete'));
        }
        await apk.appendUpload(resolve(session.workspace, 'upload'), file, offset);
        session.offset += bytes;
      } catch (error) {
        throw new ApplicationError({ status: 400, message: message(error) });
      } finally {
        try {
          await files.removeAsync(file);
        } finally {
          writing = false;
        }
      }

      if (session.offset < session.size) {
        expire(session);

        return sessionStatus(session);
      }

      // Hold off other requests until the build has taken over from the upload.
      writing = true;
      try {
        const steps = await stepsFor();
        clearTimeout(expiry);
        upload = undefined;
        log.info('android.upload_received', 'Received the Zwift Android upload', {
          upload: session.name,
          bytes: session.size,
        });
        void run(() => keepOriginal(session), begin('upload', steps));
      } finally {
        writing = false;
      }

      return sessionStatus(session);
    },
    /** Download the latest release from APKPure and build it. */
    async fetchLatest() {
      await startDownload();

      return adminStatus();
    },
    /** Build the app again from the saved original, as after a certificate change. */
    async rebuild() {
      serverCertificate();
      await startRebuild();

      return adminStatus();
    },
    stop() {
      abort?.abort(new Error(t('zwift_android_cancelled_by_admin')));

      return adminStatus();
    },
    async remove() {
      requireIdle();
      await files.removeAsync(appPath);
      await files.removeAsync(metaPath);
      log.info('android.removed', 'Removed Zwift for Zluggish from this server');

      return adminStatus();
    },
  };
});

export class ZwiftAndroidService extends Context.Service<ZwiftAndroidService, Effect.Success<typeof make>>()(
  'zluggish/ZwiftAndroidService',
) {
  static readonly layer = Layer.effect(ZwiftAndroidService, make);
}
