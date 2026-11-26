import { t } from '#src/i18n/index';
import { RuntimeContext } from '#src/context';
import { ApplicationError } from '#src/errors';
import type { ApkSigner, ApkUpload } from '#src/repositories/apk.repository';
import { ApkRepository, originalCompanionPackage, standaloneCompanionPackage } from '#src/repositories/apk.repository';
import { AppReleaseRepository, releaseSources } from '#src/repositories/app-release.repository';
import type { CertificateMaterial } from '#src/repositories/certificate.repository';
import { CertificateRepository } from '#src/repositories/certificate.repository';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { AssetFiles } from '#src/repositories/files.repository';
import type { ToolchainState } from '#src/repositories/toolchain.repository';
import { ToolchainRepository } from '#src/repositories/toolchain.repository';
import { BuildLog } from '#src/repositories/build-log.repository';
import { TlsService } from '#src/services/tls.service';
import { Context, Effect, Layer, Schema } from 'effect';
import { dirname, resolve } from 'node:path';

/** The raw resource a rebuilt app reads the server certificate from. */
const certificateResource = 'zluggish_server_cert';

/** The largest upload: Companion is about 180 MB, a bundle of splits a little more. */
export const companionUploadLimit = 1_000_000_000;

export type CompanionStep =
  | 'download'
  | 'runtime'
  | 'editor'
  | 'inspect'
  | 'merge'
  | 'decode'
  | 'patch'
  | 'build'
  | 'sign'
  | 'publish';

export interface CompanionActivity {
  /** `patch` follows an upload; `rebuild` patches the saved upload again; `download` fetches the latest release from
  APKPure first. */
  readonly kind: 'toolchain' | 'patch' | 'rebuild' | 'download' | 'rekey';
  /** `waiting`: an upload needs the Java tools, and holds until the administrator downloads them or discards it. */
  readonly state: 'running' | 'waiting' | 'done' | 'failed';
  readonly steps: ReadonlyArray<CompanionStep>;
  readonly step: CompanionStep;
  readonly progress: number | null;
  readonly message: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/** The patched app on this server, as companion.json in storage records it.

`packageName` identifies builds that can be installed alongside the Play Store app. Older builds need a new upload.
`certificate` is the SHA-256 fingerprint of the server certificate the app trusts. `method` is `rekey` when the
upload already trusted a certificate, which was swapped, and `rebuild` when its resources were rebuilt.
*/
const publishedSchema = Schema.Struct({
  packageName: Schema.Literal(standaloneCompanionPackage),
  versionName: Schema.String,
  versionCode: Schema.Finite,
  bytes: Schema.Finite,
  createdAt: Schema.String,
  certificate: Schema.String,
  method: Schema.Literals(['rekey', 'rebuild']),
});

type Published = typeof publishedSchema.Type;

/** What every rider sees: whether there is an app to download, and for which certificate. */
export interface CompanionStatus {
  readonly app: {
    readonly versionName: string;
    readonly versionCode: number;
    readonly bytes: number;
    readonly createdAt: string;
    /** False when the server certificate changed since, and the app no longer connects until it is patched again. */
    readonly current: boolean;
  } | null;
  readonly tlsMode: 'managed' | 'legacy' | 'custom';
  readonly serverAddress: string;
}

export interface CompanionAdminStatus extends CompanionStatus {
  readonly toolchain: ToolchainState & { readonly folder: string };
  readonly activity: CompanionActivity | null;
  readonly pending: boolean;
  /** The last accepted upload, kept outside backups so the app can be built again without a new one. */
  readonly original: { readonly name: string; readonly bytes: number; readonly uploadedAt: string } | null;
  readonly uploadLimit: number;
}

/** What an upload needs: the certificate entries to swap, or none when its resources must be rebuilt. */
interface Plan {
  readonly upload: Exclude<ApkUpload, { kind: 'unknown' }>;
  readonly rekey: ReadonlyArray<string>;
}

/** A job to run on a file. Its workspace is removed when the job ends; the file itself may live outside it. */
interface Job {
  readonly path: string;
  readonly workspace: string;
  readonly plan: Plan;
  readonly kind: 'patch' | 'rebuild' | 'download';
}

/** The steps a job takes: a certificate swap needs no Java, a rebuild decodes and builds the app. */
function stepsFor(plan: Plan): Array<CompanionStep> {
  if (plan.rekey.length > 0) {
    return ['inspect', 'sign', 'publish'];
  }

  return [
    'inspect',
    ...(plan.upload.kind === 'bundle' ? (['merge'] as const) : []),
    'decode',
    'patch',
    'build',
    'sign',
    'publish',
  ];
}

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const tls = yield* TlsService;
  const log = context.world.lifecycle.log;
  const job = new BuildLog(log, 'companion', 'Zwift Companion');
  const apk = new ApkRepository();
  const releases = new AppReleaseRepository();
  const crypto = new CryptoRepository();
  const certificates = new CertificateRepository();
  const files = new AssetFiles();
  const folder = resolve(context.config.storageDir, 'companion');
  const appPath = resolve(folder, 'zwift-companion.apk');
  const metaPath = resolve(folder, 'companion.json');
  const signerPath = resolve(folder, 'signer.pem');
  const originalFolder = resolve(folder, 'original');
  const originalPath = resolve(originalFolder, 'upload');
  const originalNamePath = resolve(originalFolder, 'name');
  // A cache beside storage, like backups: storage holds data only, and the tools can be downloaded again.
  const toolchain = new ToolchainRepository(resolve(dirname(context.config.storageDir), 'tools'));

  let activity: CompanionActivity | null = null;
  let abort: AbortController | null = null;
  let rekeyAfter = false;

  /** An upload that needs the Java tools, kept until they are downloaded or the administrator discards it. */
  let pending: Job | null = null;

  async function original() {
    const [name, info] = await Promise.all([files.readAsync(originalNamePath), files.statAsync(originalPath)]);

    if (!name || !info || info.directory) {
      return null;
    }

    return { name: name.toString('utf8'), bytes: info.bytes, uploadedAt: new Date(info.modified).toISOString() };
  }

  /** Keep an accepted upload as the one original to build from again, replacing any before it. */
  async function keepOriginal(path: string, name: string) {
    // A crash between staging and the swap leaves a staged copy behind.
    for (const entry of await files.entriesAsync(folder)) {
      if (entry.isDirectory() && entry.name.startsWith('upload-')) {
        await apk.removeTree(resolve(folder, entry.name));
      }
    }

    const staged = await apk.workspace(folder);

    try {
      await apk.copy(path, resolve(staged, 'upload'));
      await files.writeDurableAsync(resolve(staged, 'name'), name);
      await apk.removeTree(originalFolder);
      await apk.retainUpload(staged, originalFolder);
      await files.syncDirectoryAsync(folder);
    } catch (error) {
      await apk.removeTree(staged);
      throw error;
    }
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

  /** The certificate a patched app should trust: the first certificate the API listener presents. */
  function serverCertificate() {
    const mode = tls.mode();
    const material = tls.material();

    if (mode === 'legacy') {
      throw new ApplicationError({
        status: 409,
        message: t('companion_shared_certificate_blocked'),
      });
    }

    if (!material) {
      throw new ApplicationError({
        status: 409,
        message: t('companion_certificate_unavailable'),
      });
    }

    const pem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(material.cert)?.[0];
    if (!pem) {
      throw new ApplicationError({
        status: 409,
        message: t('companion_certificate_pem_missing'),
      });
    }

    return { pem: pem + '\n', fingerprint: crypto.certificateFacts(pem).fingerprint256 };
  }

  /** The key that signs every app this server builds, made on first use. Android updates an app only when the
  signature matches, so losing it means every rider uninstalls once. It lives in storage and in backups.
  */
  async function signer(): Promise<ApkSigner> {
    let material: CertificateMaterial | null = certificates.read(signerPath);

    if (!material) {
      material = await certificates.createApkSigner({
        serverId: crypto.randomBytes(6).toString('hex'),
        years: 50,
        now: new Date(),
      });
      await certificates.write(signerPath, material);
      log.info('companion.signer_created', 'Created the key that signs the Zwift Companion app', { path: signerPath });
    }

    return {
      key: material.key,
      certificate: Buffer.from(material.cert.replaceAll(/-----[A-Z ]+-----|\s/g, ''), 'base64'),
      publicKey: crypto.certificatePublicKey(material.cert),
    };
  }

  async function status(): Promise<CompanionStatus> {
    const app = await published();
    let fingerprint: string | null;

    try {
      fingerprint = serverCertificate().fingerprint;
    } catch {
      fingerprint = null;
    }

    return {
      app: app && {
        versionName: app.versionName,
        versionCode: app.versionCode,
        bytes: app.bytes,
        createdAt: app.createdAt,
        current: app.certificate === fingerprint,
      },
      tlsMode: tls.mode(),
      serverAddress: context.config.server.advertisedIp,
    };
  }

  async function adminStatus(): Promise<CompanionAdminStatus> {
    return {
      ...(await status()),
      toolchain: { ...(await toolchain.state()), folder: toolchain.folder },
      activity,
      pending: pending !== null,
      original: await original(),
      uploadLimit: companionUploadLimit,
    };
  }

  function begin(kind: CompanionActivity['kind'], steps: ReadonlyArray<CompanionStep>) {
    if (activity?.state === 'running') {
      throw new ApplicationError({
        status: 409,
        message: t('companion_job_busy'),
      });
    }
    const step = steps[0];
    if (!step) {
      throw new Error(t('companion_job_steps_required'));
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

  function advance(step: CompanionStep, progress: number | null = null) {
    if (!activity) {
      return;
    }
    job.step(step);
    activity = { ...activity, step, progress };
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

    if (!rekeyAfter) {
      return;
    }

    rekeyAfter = false;
    void rekeyPublished();
  }

  /** Sign `input` into place as the published app, with the certificate entries replaced. */
  async function sign(input: string, certificatesIn: ReadonlyArray<string>, pem: string, workspace: string) {
    const output = resolve(workspace, 'signed.apk');
    const replace = new Map(certificatesIn.map((name) => [name, Buffer.from(pem, 'utf8')]));

    await apk.rewrite(input, output, await signer(), { replace });

    const trusted = await apk.trustedCertificates(output);
    job.info('signed', 'Signed the app', {
      replaced: certificatesIn.join(', '),
      trusted: trusted.join(', '),
      bytes: (await apk.size(output)) ?? 0,
    });

    if (trusted.length === 0) {
      throw new Error(t('companion_build_certificate_verification_failed'));
    }

    return output;
  }

  async function publish(output: string, fingerprint: string, method: Published['method']) {
    const manifest = await apk.manifest(output);
    if (manifest.packageName !== standaloneCompanionPackage) {
      throw new Error(t('companion_patched_app_package_expected', { value1: standaloneCompanionPackage }));
    }

    advance('publish');
    await apk.publish(output, appPath);

    const record: Published = {
      packageName: manifest.packageName,
      versionName: manifest.versionName,
      versionCode: manifest.versionCode,
      bytes: (await apk.size(appPath)) ?? 0,
      createdAt: new Date().toISOString(),
      certificate: fingerprint,
      method,
    };

    await files.writeDurableAsync(metaPath, JSON.stringify(record, null, 2), true);
    log.info('companion.published', 'Published a Zwift Companion app for this server', {
      version: record.versionName,
      method,
      fingerprint,
    });
  }

  /** Check what was uploaded before the job starts, so the administrator hears about a wrong file at once. */
  async function inspect(path: string): Promise<Plan> {
    const upload = await apk.inspect(path);

    if (upload.kind === 'unknown') {
      throw new ApplicationError({ status: 400, message: t('companion_file_type_unsupported') });
    }

    if (upload.kind === 'bundle') {
      job.info('inspected', 'The upload is a bundle of split APKs', { splits: upload.apks.join(', ') });

      return { upload, rekey: [] };
    }
    const manifest = await apk.manifest(path);
    job.info('inspected', 'The upload is a single APK', {
      package: manifest.packageName,
      versionName: manifest.versionName,
      versionCode: manifest.versionCode,
      minSdk: manifest.minSdk,
    });

    if (manifest.packageName !== originalCompanionPackage && manifest.packageName !== standaloneCompanionPackage) {
      throw new ApplicationError({
        status: 400,
        message: t('companion_apk_app_mismatch', {
          value1: manifest.packageName || t('companion_unknown_app'),
          value2: originalCompanionPackage,
        }),
      });
    }

    if (manifest.minSdk < 24) {
      throw new ApplicationError({
        status: 400,
        message: t('companion_version_unsupported'),
      });
    }

    if (manifest.packageName === originalCompanionPackage) {
      return { upload, rekey: [] };
    }
    const rekey = await apk.trustedCertificates(path);
    job.info('already_patched', 'The upload is already a Zluggish build, so only its certificate is swapped', {
      certificates: rekey.join(', '),
    });

    if (rekey.length === 0) {
      throw new ApplicationError({ status: 400, message: t('companion_patched_certificate_missing') });
    }

    return { upload, rekey };
  }

  function start(next: Job) {
    const signal = begin(next.kind, stepsFor(next.plan));
    void patch(next.path, next.workspace, next.plan, signal);
  }

  /** Start a job, or hold it while the Java tools it needs download, when this system supports them. */
  async function queue(next: Job) {
    const tools = await toolchain.state();

    if (next.plan.rekey.length > 0 || (tools.java && tools.editor)) {
      start(next);

      return;
    }

    job.info('waiting_for_tools', 'The Companion job waits for the Java tools', {
      java: tools.java?.version ?? null,
      editor: tools.editor,
      supported: tools.supported,
      downloadBytes: tools.downloadBytes,
    });
    pending = next;
    activity = {
      kind: next.kind,
      state: 'waiting',
      steps: stepsFor(next.plan),
      step: 'decode',
      progress: null,
      message: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };

    if (tools.supported) {
      installTools();
    }
  }

  function installTools() {
    const signal = begin('toolchain', ['runtime', 'editor']);

    void (async () => {
      try {
        const before = await toolchain.state();
        job.info('installing_tools', 'Downloading the Java tools', {
          java: before.java?.version ?? null,
          editor: before.editor,
          downloadBytes: before.downloadBytes,
          folder: toolchain.folder,
        });
        await toolchain.install(signal, (step, fraction) => advance(step, fraction));
        log.info('companion.toolchain_installed', 'Downloaded the Java tools for the Zwift Companion app', {
          folder: toolchain.folder,
        });
        finish();

        // The upload that needs the tools continues on its own.
        const held = pending;
        pending = null;

        if (held) {
          start(held);
        }
      } catch (error) {
        log.warn('companion.toolchain_failed', 'Downloading the Java tools failed', {
          error: error instanceof Error ? error : String(error),
        });
        finish(error instanceof Error ? error.message : String(error));
      }
    })();
  }

  async function discardPending() {
    const held = pending;
    pending = null;

    if (activity?.state === 'waiting') {
      activity = null;
    }

    if (held) {
      await apk.removeTree(held.workspace);
    }
  }

  async function patch(path: string, workspace: string, plan: Plan, signal: AbortSignal) {
    try {
      const { pem, fingerprint } = serverCertificate();

      if (plan.rekey.length > 0) {
        advance('sign');
        const output = await sign(path, plan.rekey, pem, workspace);
        await publish(output, fingerprint, 'rekey');
        finish();

        return;
      }

      const tools = await toolchain.state();
      job.info('tools', 'Using these Java tools', {
        java: tools.java?.version ?? null,
        javaSource: tools.java?.source ?? null,
        javaCommand: tools.java?.command ?? null,
        editor: tools.editor,
      });

      if (!tools.java || !tools.editor) {
        throw new Error(t('companion_toolchain_missing'));
      }

      const editor = (args: ReadonlyArray<string>) =>
        job.tool('APKEditor', args, () => toolchain.editor(args, { cwd: workspace, signal }));
      let source = path;

      if (plan.upload.kind === 'bundle') {
        advance('merge');
        const splits = resolve(workspace, 'splits');
        await apk.extractApks(path, splits);
        source = resolve(workspace, 'merged.apk');
        await editor(['m', '-i', splits, '-o', source, '-f']);
        const merged = await apk.manifest(source);
        job.info('merged', 'Merged the split APKs', {
          package: merged.packageName,
          versionName: merged.versionName,
          versionCode: merged.versionCode,
          minSdk: merged.minSdk,
          bytes: (await apk.size(source)) ?? 0,
        });

        if (merged.packageName !== originalCompanionPackage) {
          throw new Error(
            t('companion_bundle_app_mismatch', {
              value1: merged.packageName || t('companion_unknown_app'),
            }),
          );
        }

        if (merged.minSdk < 24) {
          throw new Error(t('companion_version_unsupported'));
        }
      }

      advance('decode');
      const decoded = resolve(workspace, 'decoded');
      await editor(['d', '-i', source, '-o', decoded, '-f']);
      advance('patch');
      await apk.patchDecoded(decoded, pem, certificateResource);
      job.info('patched', 'Pointed the decoded app at the server certificate', {
        resource: certificateResource,
        fingerprint,
      });
      advance('build');
      const built = resolve(workspace, 'built.apk');
      await editor(['b', '-i', decoded, '-o', built, '-f']);
      job.info('rebuilt', 'Rebuilt the app', { bytes: (await apk.size(built)) ?? 0 });
      advance('sign');
      const output = await sign(built, [], pem, workspace);
      await publish(output, fingerprint, 'rebuild');
      finish();
    } catch (error) {
      log.warn('companion.patch_failed', 'Patching the Zwift Companion app failed', {
        error: error instanceof Error ? error : String(error),
      });
      finish(error instanceof Error ? error.message : String(error));
    } finally {
      await apk.removeTree(workspace);
    }
  }

  /** Fetch the latest release from APKPure, save it like an upload, and patch it in the same job. */
  async function downloadLatest(signal: AbortSignal) {
    const workspace = await apk.workspace();
    const path = resolve(workspace, 'upload');
    let plan: Plan;

    try {
      const release = await releases.apkpure(releaseSources.companion.packageName, signal);

      if (!release) {
        throw new Error(t('app_release_unavailable', { value1: 'APKPure' }));
      }
      job.info('download_started', 'Downloading Zwift Companion from APKPure', {
        version: release.versionName,
        bytes: release.bytes,
        file: release.filename,
      });
      const bytes = await releases.download(release.url, path, companionUploadLimit, signal, (fraction) =>
        advance('download', fraction),
      );
      job.info('downloaded', 'Downloaded Zwift Companion from APKPure', { bytes });
      advance('inspect');
      plan = await inspect(path);

      try {
        await keepOriginal(path, release.filename);
      } catch (error) {
        log.warn('companion.original_not_saved', 'Could not save the Zwift Companion download', {
          error: error instanceof Error ? error : String(error),
        });
      }
      const tools = await toolchain.state();

      // Without the Java tools, the patch waits for them like an upload does.
      if (plan.rekey.length === 0 && (!tools.java || !tools.editor)) {
        finish();
        await queue({ path, workspace, plan, kind: 'download' });

        return;
      }

      if (activity) {
        activity = { ...activity, steps: ['download', ...stepsFor(plan)] };
      }
    } catch (error) {
      const reason = signal.aborted
        ? t('companion_cancelled_by_admin')
        : error instanceof Error
          ? error.message
          : String(error);
      log.warn('companion.download_failed', 'Downloading Zwift Companion failed', { error: reason });
      finish(reason);
      await apk.removeTree(workspace);

      return;
    }

    await patch(path, workspace, plan, signal);
  }

  /** Swap the certificate in the published app for the current one, as after a rotation. Needs no Java. */
  async function rekeyPublished() {
    const app = await published();

    if (!app) {
      return;
    }

    if (activity?.state === 'running') {
      rekeyAfter = true;

      return;
    }

    let current: { pem: string; fingerprint: string };

    try {
      current = serverCertificate();
    } catch {
      return;
    }

    if (app.certificate === current.fingerprint) {
      return;
    }
    begin('rekey', ['sign', 'publish']);
    const workspace = await apk.workspace();

    try {
      const inside = await apk.trustedCertificates(appPath);
      const output = await sign(appPath, inside, current.pem, workspace);
      await publish(output, current.fingerprint, app.method);
      finish();
    } catch (error) {
      log.warn('companion.rekey_failed', 'Updating the certificate in the Zwift Companion app failed', {
        error: error instanceof Error ? error : String(error),
      });
      finish(error instanceof Error ? error.message : String(error));
    } finally {
      await apk.removeTree(workspace);
    }
  }

  tls.subscribe(() => {
    void rekeyPublished();
  });

  return {
    status: Effect.fn('CompanionService.status')(function* () {
      return yield* Effect.promise(status);
    }),
    adminStatus: Effect.fn('CompanionService.adminStatus')(function* () {
      return yield* Effect.promise(adminStatus);
    }),
    download: Effect.fn('CompanionService.download')(function* () {
      const app = yield* Effect.promise(published);

      return app
        ? { path: appPath, filename: `zwift-companion-${app.versionName.replaceAll(/[^\w.-]/g, '')}-zluggish.apk` }
        : null;
    }),
    /** Receive an upload and start patching it. Resolves once the file is checked; the job runs on. An upload that
    needs the Java tools downloads them automatically when this system is supported.
    */
    upload: Effect.fn('CompanionService.upload')(function* (body: ReadableStream<Uint8Array>, name: string) {
      if (activity?.state === 'running') {
        throw new ApplicationError({
          status: 409,
          message: t('companion_job_busy'),
        });
      }
      serverCertificate();
      yield* Effect.promise(discardPending);

      const workspace = yield* Effect.promise(() => apk.workspace());
      const path = resolve(workspace, 'upload');

      const plan = yield* Effect.promise(async () => {
        try {
          await apk.receive(body, path, companionUploadLimit);
          job.info('upload_received', 'Received a Zwift Companion upload', {
            upload: name,
            bytes: (await apk.size(path)) ?? 0,
          });

          return await inspect(path);
        } catch (error) {
          await apk.removeTree(workspace);

          throw error instanceof ApplicationError
            ? error
            : new ApplicationError({
                status: 400,
                message: error instanceof Error ? error.message : t('companion_upload_failed'),
              });
        }
      });

      yield* Effect.promise(async () => {
        try {
          await keepOriginal(path, name);
          job.info('original_saved', 'Saved the upload to build from again', { upload: name, folder: originalFolder });
        } catch (error) {
          // The upload still patches; only building it again later needs the saved copy.
          log.warn('companion.original_not_saved', 'Could not save the Zwift Companion upload', {
            error: error instanceof Error ? error : String(error),
          });
        }
      });
      yield* Effect.promise(() => queue({ path, workspace, plan, kind: 'patch' }));

      return yield* Effect.promise(adminStatus);
    }),
    /** Download the latest release from APKPure and patch it. Resolves once the job starts. */
    fetchLatest: Effect.fn('CompanionService.fetchLatest')(function* () {
      if (activity?.state === 'running') {
        throw new ApplicationError({
          status: 409,
          message: t('companion_job_busy'),
        });
      }
      serverCertificate();
      yield* Effect.promise(discardPending);
      // The steps after inspection depend on what APKPure serves; a single APK is the usual case.
      const signal = begin('download', ['download', 'inspect', 'decode', 'patch', 'build', 'sign', 'publish']);
      void downloadLatest(signal);

      return yield* Effect.promise(adminStatus);
    }),
    /** Patch the saved upload again, as after a failed build or for a new signing setup. */
    rebuild: Effect.fn('CompanionService.rebuild')(function* () {
      if (activity?.state === 'running') {
        throw new ApplicationError({
          status: 409,
          message: t('companion_job_busy'),
        });
      }
      serverCertificate();

      yield* Effect.promise(async () => {
        if (!(await original())) {
          throw new ApplicationError({ status: 404, message: t('companion_upload_missing') });
        }
        await discardPending();
        const plan = await inspect(originalPath);
        log.info('companion.rebuild_started', 'Building Zwift Companion from the saved upload');
        await queue({ path: originalPath, workspace: await apk.workspace(), plan, kind: 'rebuild' });
      });

      return yield* Effect.promise(adminStatus);
    }),
    remove: Effect.fn('CompanionService.remove')(function* () {
      if (activity?.state === 'running') {
        throw new ApplicationError({
          status: 409,
          message: t('companion_job_busy'),
        });
      }
      yield* Effect.promise(async () => {
        await files.removeAsync(appPath);
        await files.removeAsync(metaPath);
      });
      log.info('companion.removed', 'Removed the Zwift Companion app from this server');

      return yield* Effect.promise(adminStatus);
    }),
    installToolchain: Effect.fn('CompanionService.installToolchain')(function* () {
      installTools();

      return yield* Effect.promise(adminStatus);
    }),
    discard: Effect.fn('CompanionService.discard')(function* () {
      if (activity?.state === 'running' && activity.kind !== 'toolchain') {
        throw new ApplicationError({
          status: 409,
          message: t('companion_job_busy'),
        });
      }
      yield* Effect.promise(discardPending);

      return yield* Effect.promise(adminStatus);
    }),
    removeToolchain: Effect.fn('CompanionService.removeToolchain')(function* () {
      if (activity?.state === 'running') {
        throw new ApplicationError({
          status: 409,
          message: t('companion_job_busy'),
        });
      }
      yield* Effect.promise(() => toolchain.remove());
      activity = null;
      log.info('companion.toolchain_removed', 'Removed the Java tools', { folder: toolchain.folder });

      return yield* Effect.promise(adminStatus);
    }),
    cancel: Effect.fn('CompanionService.cancel')(function* () {
      abort?.abort(new Error(t('companion_cancelled_by_admin')));

      return yield* Effect.promise(adminStatus);
    }),
  };
});

export class CompanionService extends Context.Service<CompanionService, Effect.Success<typeof make>>()(
  'zluggish/CompanionService',
) {
  static readonly layer = Layer.effect(CompanionService, make);
}
