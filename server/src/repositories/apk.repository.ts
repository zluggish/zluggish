import { t } from '#src/i18n/index';
import { packageRoot } from '#src/config/load';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { createReadStream, createWriteStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createInflateRaw, deflateRawSync, inflateRawSync } from 'node:zlib';

interface ZipEntry {
  readonly name: string;
  readonly nameBytes: Buffer;
  readonly versionMadeBy: number;
  readonly versionNeeded: number;
  readonly flags: number;
  readonly method: number;
  readonly time: number;
  readonly date: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly internalAttributes: number;
  readonly externalAttributes: number;
  readonly localOffset: number;
}

export interface ApkManifest {
  readonly packageName: string;
  readonly versionName: string;
  readonly versionCode: number;
  readonly minSdk: number;
}

/** The key that signs a rebuilt APK: a PKCS #8 PEM private key and its self-signed certificate as DER. */
export interface ApkSigner {
  readonly key: string;
  readonly certificate: Uint8Array;
  readonly publicKey: Uint8Array;
}

export interface RewriteOptions {
  readonly drop?: (name: string) => boolean;
  readonly replace?: ReadonlyMap<string, Uint8Array>;
  readonly store?: ReadonlyMap<string, string>;
  /** Called with the share of the work done, from 0 to 1, as the archive is written and signed. */
  readonly progress?: ((fraction: number) => void) | undefined;
}

/** What an uploaded file holds: one APK, or a bundle of split APKs (.apks, .xapk or .apkm). */
export type ApkUpload = { kind: 'apk' } | { kind: 'bundle'; apks: ReadonlyArray<string> } | { kind: 'unknown' };

const zwiftPackage = 'com.zwift.zwiftgame';
export const standaloneZwiftPackage = 'com.zluggish.zwift';
const androidLauncherIcon = 'zluggish_launcher';
const zwiftSetupActivity = `${standaloneZwiftPackage}.bootstrap.SetupActivity`;
const zwiftExpansionAsset = 'assets/zluggish/expansion.obb';

export const originalCompanionPackage = 'com.zwift.android.prod';
export const standaloneCompanionPackage = 'com.zluggish.companion';

const eocdSignature = 0x06_05_4b_50;
const centralSignature = 0x02_01_4b_50;
const localSignature = 0x04_03_4b_50;

// APK Signature Scheme v2: https://source.android.com/docs/security/features/apksigning/v2
const v2BlockId = 0x71_09_87_1a;
const ecdsaSha256 = 0x02_01;
const chunkSize = 1024 * 1024;
const signingBlockMagic = Buffer.from('APK Sig Block 42', 'ascii');

// The extra field apksigner uses to pad a stored entry to its alignment.
const alignmentExtraId = 0xd9_35;

/** Native libraries are mapped straight from the APK, so they start on a page; 16 KB covers every page size. */
const pageAlignment = 16_384;

// Android resource IDs of the manifest attributes this reads (android.R.attr).
const attributeIds = { versionCode: 0x01_01_02_1b, versionName: 0x01_01_02_1c, minSdkVersion: 0x01_01_02_0c } as const;

const u16 = (value: number) => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);

  return bytes;
};

const u32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);

  return bytes;
};

const u64 = (value: number) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));

  return bytes;
};

/** A length-prefixed value, as every field of a v2 signature block is. */
const prefixed = (...parts: Array<Uint8Array>) => {
  const body = Buffer.concat(parts);

  return Buffer.concat([u32(body.length), body]);
};

/** True for the JAR signature files of a v1 signature, which a rebuilt APK must not keep. */
export const isJarSignature = (name: string) =>
  name === 'META-INF/MANIFEST.MF' || /^META-INF\/[^/]+\.(?:SF|RSA|DSA|EC)$/i.test(name);

function qualifyZwiftClass(name: string) {
  if (name.startsWith('.')) {
    return zwiftPackage + name;
  }

  return name.includes('.') ? name : `${zwiftPackage}.${name}`;
}

function renameZwiftIdentifier(name: string) {
  return name === zwiftPackage || name.startsWith(`${zwiftPackage}.`)
    ? standaloneZwiftPackage + name.slice(zwiftPackage.length)
    : name;
}

/** Declare a resource at the next free entry ID without shifting any existing IDs. */
function declareAndroidResource(publicXml: string, type: string, name: string) {
  if (
    new RegExp(`<public[^>]*type="${type}"[^>]*name="${name}"|<public[^>]*name="${name}"[^>]*type="${type}"`).test(
      publicXml,
    )
  ) {
    return publicXml;
  }

  const ids = publicXml
    .matchAll(/<public\b[^>]*>/g)
    .map((match) => ({
      type: /type="([^"]+)"/.exec(match[0])?.[1],
      id: Number.parseInt(/id="0x([\da-f]+)"/i.exec(match[0])?.[1] ?? '0', 16),
    }))
    .toArray();

  const sameType = ids
    .values()
    .filter((entry) => entry.type === type)
    .map((entry) => entry.id)
    .toArray();

  const packageId = (ids[0]?.id ?? 0x7f_00_00_00) & 0xff_00_00_00;

  const id =
    sameType.length > 0
      ? Math.max(...sameType) + 1
      : packageId | ((Math.max(0, ...ids.map((entry) => (entry.id >>> 16) & 0xff)) + 1) << 16);

  return publicXml.replace(
    /<\/resources>\s*$/,
    () =>
      `  <public id="0x${(id >>> 0).toString(16).padStart(8, '0')}" type="${type}" name="${name}" />\n</resources>\n`,
  );
}

async function installAndroidLauncherIcon(res: string, publicXml: string) {
  const drawable = resolve(res, 'drawable');
  await mkdir(drawable, { recursive: true });
  await copyFile(
    resolve(packageRoot(), '../assets/android/zluggish-launcher.xml'),
    resolve(drawable, `${androidLauncherIcon}.xml`),
  );

  return declareAndroidResource(publicXml, 'drawable', androidLauncherIcon);
}

function newZipEntry(name: string, method: number, size: number, compressedSize: number, crc: number) {
  const now = new Date();

  return {
    name,
    nameBytes: Buffer.from(name),
    versionMadeBy: 20,
    versionNeeded: 20,
    flags: 0x08_00,
    method,
    time: (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2),
    date: ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
    crc,
    compressedSize,
    size,
    internalAttributes: 0,
    externalAttributes: 0,
  };
}

async function readAt(handle: FileHandle, position: number, length: number) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);

  if (bytesRead !== length) {
    throw new Error(t('archive_truncated'));
  }

  return buffer;
}

function zip64Number(bytes: Buffer, offset: number) {
  const number = Number(bytes.readBigUInt64LE(offset));

  if (!Number.isSafeInteger(number)) {
    throw new TypeError(t('apk_zip64_bounds_invalid'));
  }

  return number;
}

async function zip64Directory(handle: FileHandle, end: number) {
  const locator = await readAt(handle, end - 20, 20);

  if (locator.readUInt32LE(0) !== 0x07_06_4b_50 || locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) {
    throw new Error(t('apk_zip64_locator_invalid'));
  }

  const position = zip64Number(locator, 8);
  const record = await readAt(handle, position, 56);

  if (
    record.readUInt32LE(0) !== 0x06_06_4b_50 ||
    record.readUInt32LE(16) !== 0 ||
    record.readUInt32LE(20) !== 0 ||
    position + 12 + zip64Number(record, 4) !== end - 20
  ) {
    throw new Error(t('apk_zip64_end_record_invalid'));
  }

  return {
    count: zip64Number(record, 32),
    length: zip64Number(record, 40),
    offset: zip64Number(record, 48),
    end: position,
  };
}

function zipEntrySizes(
  directory: Buffer,
  position: number,
  extraStart: number,
  extraLength: number,
  allowZip64: boolean,
) {
  const fields = [24, 20, 42].map((offset) => directory.readUInt32LE(position + offset));

  if (fields.includes(0xff_ff_ff_ff)) {
    if (!allowZip64) {
      throw new Error(t('apk_zip64_unsupported'));
    }

    let field = extraStart;
    const end = extraStart + extraLength;

    while (field + 4 <= end) {
      const id = directory.readUInt16LE(field);
      const size = directory.readUInt16LE(field + 2);
      const start = field + 4;
      field = start + size;

      if (field > end) {
        break;
      }

      if (id === 1) {
        let next = start;

        return fields.map((value) => {
          if (value !== 0xff_ff_ff_ff) {
            return value;
          }
          if (next + 8 > field) {
            throw new Error(t('apk_zip64_entry_truncated'));
          }
          const actual = zip64Number(directory, next);
          next += 8;

          return actual;
        });
      }
    }

    throw new Error(t('apk_zip64_entry_sizes_missing'));
  }

  return fields;
}

async function centralDirectory(handle: FileHandle, allowZip64 = false) {
  const { size } = await handle.stat();
  const tailLength = Math.min(size, 65_557);
  const tail = await readAt(handle, size - tailLength, tailLength);
  let at = -1;

  for (let index = tail.length - 22; index >= 0; index--) {
    if (tail.readUInt32LE(index) === eocdSignature) {
      at = index;
      break;
    }
  }

  if (at === -1) {
    throw new Error(t('apk_archive_invalid'));
  }
  let end = size - tailLength + at;
  let count = tail.readUInt16LE(at + 10);
  let length = tail.readUInt32LE(at + 12);
  let offset = tail.readUInt32LE(at + 16);

  if (count === 0xff_ff || length === 0xff_ff_ff_ff || offset === 0xff_ff_ff_ff) {
    if (!allowZip64 || end < 20) {
      throw new Error(t('apk_zip64_unsupported'));
    }

    ({ count, length, offset, end } = await zip64Directory(handle, end));
  }

  if (offset > end || length > end - offset || length > 64 * 1024 * 1024 || count > length / 46) {
    throw new Error(t('apk_archive_directory_invalid'));
  }
  const directory = await readAt(handle, offset, length);
  const entries: Array<ZipEntry> = [];
  let position = 0;

  for (let index = 0; index < count; index++) {
    if (position + 46 > directory.length || directory.readUInt32LE(position) !== centralSignature) {
      throw new Error(t('apk_archive_directory_corrupt'));
    }
    const nameLength = directory.readUInt16LE(position + 28);
    const extraLength = directory.readUInt16LE(position + 30);
    const commentLength = directory.readUInt16LE(position + 32);
    const extraStart = position + 46 + nameLength;
    const next = extraStart + extraLength + commentLength;

    if (next > directory.length) {
      throw new Error(t('apk_archive_directory_corrupt'));
    }

    const nameBytes = Buffer.from(directory.subarray(position + 46, extraStart));
    const [size = 0, compressedSize = 0, localOffset = 0] = zipEntrySizes(
      directory,
      position,
      extraStart,
      extraLength,
      allowZip64,
    );

    entries.push({
      name: nameBytes.toString('utf8'),
      nameBytes,
      versionMadeBy: directory.readUInt16LE(position + 4),
      versionNeeded: directory.readUInt16LE(position + 6),
      flags: directory.readUInt16LE(position + 8),
      method: directory.readUInt16LE(position + 10),
      time: directory.readUInt16LE(position + 12),
      date: directory.readUInt16LE(position + 14),
      crc: directory.readUInt32LE(position + 16),
      compressedSize,
      size,
      internalAttributes: directory.readUInt16LE(position + 36),
      externalAttributes: directory.readUInt32LE(position + 38),
      localOffset,
    });
    position = next;
  }

  return entries;
}

async function dataOffset(handle: FileHandle, entry: ZipEntry) {
  const header = await readAt(handle, entry.localOffset, 30);

  if (header.readUInt32LE(0) !== localSignature) {
    throw new Error(t('apk_archive_entry_corrupt', { value1: entry.name }));
  }

  return entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
}

async function readEntry(handle: FileHandle, entry: ZipEntry, maxOutputLength?: number) {
  const raw = await readAt(handle, await dataOffset(handle, entry), entry.compressedSize);

  if (entry.method === 0) {
    return raw;
  }

  if (entry.method === 8) {
    return inflateRawSync(raw, { maxOutputLength });
  }

  throw new Error(t('apk_compression_unsupported', { value1: entry.name }));
}

/** A reader for Android's binary XML, enough for the manifest's package, version and minimum SDK. */
function readBinaryXml(buffer: Buffer) {
  let strings: Array<string> = [];
  let resourceIds: Array<number> = [];
  const elements: Array<{ name: string; attributes: Map<string | number, string | number> }> = [];
  let position = 8;

  while (position + 8 <= buffer.length) {
    const type = buffer.readUInt16LE(position);
    const headerSize = buffer.readUInt16LE(position + 2);
    const size = buffer.readUInt32LE(position + 4);

    if (size < 8) {
      break;
    }

    switch (type) {
      case 0x00_01: {
        const count = buffer.readUInt32LE(position + 8);
        const utf8 = (buffer.readUInt32LE(position + 16) & 0x1_00) !== 0;
        const start = position + buffer.readUInt32LE(position + 20);
        strings = [];

        for (let index = 0; index < count; index++) {
          let at = start + buffer.readUInt32LE(position + headerSize + index * 4);

          if (utf8) {
            // The UTF-16 length, then the UTF-8 length; each is one byte, or two with the high bit set.
            at += (buffer[at] ?? 0) & 0x80 ? 2 : 1;
            let length = buffer[at] ?? 0;

            if (length & 0x80) {
              length = ((length & 0x7f) << 8) | (buffer[at + 1] ?? 0);
              at += 2;
            } else {
              at += 1;
            }
            strings.push(buffer.toString('utf8', at, at + length));
          } else {
            let length = buffer.readUInt16LE(at);
            at += 2;

            if (length & 0x80_00) {
              length = ((length & 0x7f_ff) << 16) | buffer.readUInt16LE(at);
              at += 2;
            }

            strings.push(buffer.toString('utf16le', at, at + length * 2));
          }
        }

        break;
      }

      case 0x01_80: {
        resourceIds = [];

        for (let at = position + 8; at < position + size; at += 4) {
          resourceIds.push(buffer.readUInt32LE(at));
        }

        break;
      }

      case 0x01_02: {
        const name = strings[buffer.readInt32LE(position + 20)] ?? '';
        const attributeStart = buffer.readUInt16LE(position + 24);
        const attributeSize = buffer.readUInt16LE(position + 26);
        const count = buffer.readUInt16LE(position + 28);
        const attributes = new Map<string | number, string | number>();

        for (let index = 0; index < count; index++) {
          const at = position + 16 + attributeStart + index * attributeSize;
          const nameIndex = buffer.readInt32LE(at + 4);
          const dataType = buffer.readUInt8(at + 15);
          const data = buffer.readUInt32LE(at + 16);
          const value = dataType === 0x03 ? (strings[data] ?? '') : data;
          // Obfuscated manifests may blank attribute names; their resource IDs remain.
          const id = resourceIds[nameIndex];

          if (id !== undefined) {
            attributes.set(id, value);
          }
          attributes.set(strings[nameIndex] ?? '', value);
        }

        elements.push({ name, attributes });

        break;
      }
      // No default
    }

    position += size;
  }

  return elements;
}

export class ApkRepository {
  constructor(private readonly crypto = new CryptoRepository()) {}

  async inspect(path: string): Promise<ApkUpload> {
    const handle = await open(path, 'r');

    try {
      const entries = await centralDirectory(handle);
      const names = entries.map((entry) => entry.name);

      if (names.includes('AndroidManifest.xml')) {
        return { kind: 'apk' };
      }
      const apks = names.filter((name) => name.endsWith('.apk') && !name.includes('/'));

      return apks.length > 0 ? { kind: 'bundle', apks } : { kind: 'unknown' };
    } catch {
      return { kind: 'unknown' };
    } finally {
      await handle.close();
    }
  }

  /** Copy the split APKs of a bundle into a folder, for a merge tool to read. */
  async extractApks(path: string, folder: string) {
    const handle = await open(path, 'r');

    try {
      await mkdir(folder, { recursive: true });

      for (const entry of await centralDirectory(handle)) {
        if (!entry.name.endsWith('.apk') || entry.name.includes('/')) {
          continue;
        }
        const start = await dataOffset(handle, entry);
        const target = resolve(folder, entry.name);

        if (entry.compressedSize === 0) {
          await writeFile(target, new Uint8Array());
          continue;
        }

        const source = createReadStream(path, { start, end: start + entry.compressedSize - 1 });

        await (entry.method === 8
          ? pipeline(source, createInflateRaw(), createWriteStream(target))
          : pipeline(source, createWriteStream(target)));
      }
    } finally {
      await handle.close();
    }
  }

  async manifest(path: string): Promise<ApkManifest> {
    const { packageName, versionName, versionCode, minSdk } = await this.manifestWithSplit(path);

    return { packageName, versionName, versionCode, minSdk };
  }

  private async manifestWithSplit(path: string) {
    const handle = await open(path, 'r');

    try {
      const entries = await centralDirectory(handle);
      const entry = entries.find((candidate) => candidate.name === 'AndroidManifest.xml');

      if (!entry) {
        throw new Error(t('apk_manifest_missing'));
      }
      const manifestLimit = 4 * 1024 ** 2;
      if (entry.size > manifestLimit || entry.compressedSize > manifestLimit) {
        throw new Error(t('apk_manifest_size_limit'));
      }
      const elements = readBinaryXml(await readEntry(handle, entry, manifestLimit));
      const root = elements.find((element) => element.name === 'manifest');
      const sdk = elements.find((element) => element.name === 'uses-sdk');
      const versionCode = root?.attributes.get(attributeIds.versionCode) ?? root?.attributes.get('versionCode');
      const versionName = root?.attributes.get(attributeIds.versionName) ?? root?.attributes.get('versionName');
      const minSdk = sdk?.attributes.get(attributeIds.minSdkVersion) ?? sdk?.attributes.get('minSdkVersion') ?? 1;

      return {
        packageName: String(root?.attributes.get('package') ?? ''),
        split: String(root?.attributes.get('split') ?? ''),
        versionName: String(versionName ?? ''),
        versionCode: Number(versionCode ?? 0),
        minSdk: Number(minSdk) || 1,
      };
    } finally {
      await handle.close();
    }
  }

  /** The raw resources that hold a PEM certificate: the ones a patched app's network security config trusts. */
  async trustedCertificates(path: string) {
    const handle = await open(path, 'r');

    try {
      const found: Array<string> = [];

      for (const entry of await centralDirectory(handle)) {
        if (!entry.name.startsWith('res/raw/') || entry.size > 16_384) {
          continue;
        }

        const contents = await readEntry(handle, entry);

        if (contents.includes('-----BEGIN CERTIFICATE-----')) {
          found.push(entry.name);
        }
      }

      return found;
    } finally {
      await handle.close();
    }
  }

  /** Extract one Zwift expansion from an APKM without extracting its APKs or trusting archive paths. */
  async extractZwiftObb(
    path: string,
    output: string,
    limit: number,
    signal: AbortSignal,
    progress?: (fraction: number) => void,
  ) {
    await using handle = await open(path, 'r');
    const entries = await centralDirectory(handle, true);
    const expansions = entries.filter((entry) =>
      /(?:^|\/)main\.\d{1,12}\.com\.zwift\.zwiftgame\.obb$/.test(entry.name),
    );
    const [expansion] = expansions;

    if (expansions.length !== 1 || !expansion) {
      throw new Error(t('apk_expansion_file_required'));
    }

    await this.extractBundleEntry(path, handle, expansion, output, limit, signal, progress);

    return expansion.name.slice(expansion.name.lastIndexOf('/') + 1);
  }

  private async extractBundleEntry(
    path: string,
    handle: FileHandle,
    entry: ZipEntry,
    output: string,
    limit: number,
    signal: AbortSignal,
    progress?: (fraction: number) => void,
  ) {
    const start = await dataOffset(handle, entry);
    const { size } = await handle.stat();

    if (
      entry.size === 0 ||
      entry.size > limit ||
      entry.compressedSize === 0 ||
      start + entry.compressedSize > size ||
      (entry.method !== 0 && entry.method !== 8) ||
      (entry.flags & 1) !== 0
    ) {
      throw new Error(t('apk_entry_unsupported', { value1: entry.name }));
    }

    let extracted = 0;
    let crc = 0;
    const count = new Transform({
      transform(chunk: Buffer, _encoding, next) {
        extracted += chunk.length;
        crc = crc32(chunk, crc);
        progress?.(Math.min(1, extracted / entry.size));
        next(extracted > entry.size ? new Error(t('apk_entry_size_mismatch')) : null, chunk);
      },
    });
    const source = createReadStream(path, { start, end: start + entry.compressedSize - 1 });
    const target = createWriteStream(output, { flags: 'wx', mode: 0o600 });

    if (entry.method === 8) {
      await pipeline(source, createInflateRaw(), count, target, { signal });
    } else {
      await pipeline(source, count, target, { signal });
    }

    if (extracted !== entry.size || crc !== entry.crc) {
      throw new Error(t('apk_entry_corrupt', { value1: entry.name }));
    }
  }

  async extractZwiftApks(input: string, folder: string, versionCode: number, signal: AbortSignal) {
    await using handle = await open(input, 'r');
    const entries = await centralDirectory(handle, true);
    const apks = entries.filter((entry) => /^[\w.-]+\.apk$/.test(entry.name));
    if (apks.length === 0 || apks.length > 100 || new Set(apks.map((entry) => entry.name)).size !== apks.length) {
      throw new Error(t('apk_bundle_structure_invalid'));
    }

    await mkdir(folder, { recursive: true });
    const splits = new Set<string>();
    let base: { path: string; manifest: ApkManifest } | undefined;

    for (const entry of apks) {
      const path = resolve(folder, entry.name);
      await this.extractBundleEntry(input, handle, entry, path, 512 * 1024 ** 2, signal);
      const manifest = await this.manifestWithSplit(path);
      if (manifest.packageName !== zwiftPackage || manifest.versionCode !== versionCode || splits.has(manifest.split)) {
        throw new Error(t('apk_bundle_version_conflict'));
      }
      splits.add(manifest.split);
      if (!manifest.split) {
        base = { path, manifest };
      }
    }

    if (!base) {
      throw new Error(t('apk_base_apk_missing'));
    }

    return { base, parts: apks.map((entry) => resolve(folder, entry.name)) };
  }

  /** Keep Java class names intact while giving the installed application and its providers a separate identity. */
  async configureDecodedZwift(folder: string, versionCode: number) {
    const manifestPath = resolve(folder, 'AndroidManifest.xml');
    const original = await readFile(manifestPath, 'utf8');
    const originalPackage = /<manifest\s[^>]*?\bpackage=(["'])([^"']+)\1/.exec(original)?.[2];
    if (originalPackage !== zwiftPackage) {
      throw new Error(t('apk_application_mismatch'));
    }

    const appTag = /<application\b[^>]*>/;
    let manifest = original
      .replace(
        /(<manifest\s[^>]*?\bpackage=)(["'])([^"']+)\2/,
        (_, start: string) => `${start}"${standaloneZwiftPackage}"`,
      )
      .replaceAll(/<(?:application|activity(?:-alias)?|provider|receiver|service|instrumentation)\b[^>]*>/g, (tag) =>
        tag.replaceAll(
          /\bandroid:(name|targetActivity|parentActivityName|backupAgent|appComponentFactory|manageSpaceActivity|zygotePreloadName)=(["'])([^"']+)\2/g,
          (_, attribute: string, quote: string, name: string) =>
            `android:${attribute}=${quote}${qualifyZwiftClass(name)}${quote}`,
        ),
      )
      .replaceAll(
        /\bandroid:(authorities|permission|readPermission|writePermission|targetPackage)=(["'])([^"']+)\2/g,
        (_, attribute: string, quote: string, value: string) =>
          `android:${attribute}=${quote}${value
            .split(';')
            .map((part) => renameZwiftIdentifier(part))
            .join(';')}${quote}`,
      )
      .replaceAll(/<(?:permission(?:-group|-tree)?|uses-permission(?:-sdk-23)?)\b[^>]*>/g, (tag) =>
        tag.replace(
          /\bandroid:name=(["'])([^"']+)\1/,
          (_, quote: string, name: string) => `android:name=${quote}${renameZwiftIdentifier(name)}${quote}`,
        ),
      )
      .replace(appTag, (tag) => {
        const originalBrandingRemoved = tag.replaceAll(/\s+android:(?:label|icon|roundIcon)=(["'])[^"']*\1/g, '');
        const icon = `@drawable/${androidLauncherIcon}`;

        return originalBrandingRemoved.replace(
          '>',
          () => ` android:label="Zwift for Zluggish" android:icon="${icon}" android:roundIcon="${icon}">`,
        );
      });

    const launchers = new Set<string>();
    const launcherCategory = /<category\s+android:name=(["'])android\.intent\.category\.LAUNCHER\1\s*\/>/;
    manifest = manifest.replaceAll(
      /(<(activity(?:-alias)?)\b[^>]*[^/>]>)([\s\S]*?)(<\/\2\s*>)/g,
      (_component, tag: string, _kind: string, body: string, close: string) => {
        const redirected = body.replaceAll(/<intent-filter\b[^>]*>[\s\S]*?<\/intent-filter>/g, (filter) => {
          if (!/android:name=(["'])android\.intent\.action\.MAIN\1/.test(filter) || !launcherCategory.test(filter)) {
            return filter;
          }

          const activity = /\bandroid:name=(["'])([\w.$]+)\1/.exec(tag)?.[2];
          if (activity) {
            launchers.add(activity);
          }

          return filter.replace(launcherCategory, '');
        });

        return tag + redirected + close;
      },
    );

    const [launcher] = launchers;
    if (!launcher || launchers.size !== 1 || !/<\/application\s*>/.test(manifest)) {
      throw new Error(t('apk_launcher_activity_missing'));
    }
    const obb = `main.${versionCode}.${standaloneZwiftPackage}.obb`;
    manifest = manifest.replace(/<\/application\s*>/, () =>
      [
        `  <activity android:name="${zwiftSetupActivity}" android:exported="true" android:launchMode="singleTop"`,
        '            android:configChanges="keyboardHidden|orientation|screenSize">',
        `    <meta-data android:name="zluggish.expansion" android:value="${obb}" />`,
        `    <meta-data android:name="zluggish.launcher" android:value="${launcher}" />`,
        '    <intent-filter>',
        '      <action android:name="android.intent.action.MAIN" />',
        '      <category android:name="android.intent.category.LAUNCHER" />',
        '    </intent-filter>',
        '  </activity>',
        '</application>',
      ].join('\n'),
    );
    await writeFile(manifestPath, manifest);

    const res = await this.resourceFolder(folder);
    if (!res) {
      throw new Error(t('apk_zwift_public_resources_missing'));
    }
    const publicPath = resolve(res, 'values', 'public.xml');
    const publicXml = await readFile(publicPath, 'utf8');
    await writeFile(publicPath, await installAndroidLauncherIcon(res, publicXml));

    const resources = resolve(folder, 'resources');
    for (const entry of await readdir(resources, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^package_\d+$/.test(entry.name)) {
        continue;
      }
      const packagePath = resolve(resources, entry.name, 'package.json');
      const originalResources = await readFile(packagePath, 'utf8');
      const updated = originalResources.replace(
        /("package_name"\s*:\s*)"com\.zwift\.zwiftgame"/,
        (_, key: string) => `${key}"${standaloneZwiftPackage}"`,
      );
      if (updated !== originalResources) {
        await writeFile(packagePath, updated);
      }
    }
  }

  /** Update the original package lookups Zwift uses to find, unpack, and start the game. */
  async configureZwiftPackageLookups(folder: string) {
    const smali = resolve(folder, 'smali');
    const entries = await readdir(smali, { withFileTypes: true });
    const classes = entries.filter((dex) => dex.isDirectory());
    const readClass = async (name: string) => {
      for (const dex of classes) {
        const path = resolve(smali, dex.name, 'com/zwift/zwiftgame', name);
        try {
          return { path, source: await readFile(path, 'utf8') };
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
            throw error;
          }
        }
      }

      return null;
    };

    const helpers = await readClass('vending/expansion/downloader/Helpers.smali');
    if (!helpers) {
      throw new Error(t('apk_expansion_filename_helper_missing'));
    }
    const lookup =
      /(^\.method [^\n]*\bgetExpansionAPKFileName\(ZI\)Ljava\/lang\/String;[^\n]*\n[\s\S]*?^\.end method)/m;
    const updated = helpers.source.replace(lookup, (method) =>
      method.replace('".com.zwift.zwiftgame.obb"', () => `".${standaloneZwiftPackage}.obb"`),
    );
    if (updated === helpers.source) {
      throw new Error(t('apk_expansion_filename_patch_failed'));
    }
    await writeFile(helpers.path, updated);

    // Zwift 1.126 hardcodes the private data directory in the unpacker and its version marker.
    const downloader = await readClass('downloader/ZwiftDownloaderActivity.smali');
    const unzip = await readClass('downloader/ZwiftDownloaderActivity$AsyncUnzipTask.smali');
    if (downloader && downloader.source.includes('/data/data/com.zwift.zwiftgame/')) {
      const source = downloader.source.replace(
        /const-string(?:\/jumbo)? v0, "\/data\/data\/com\.zwift\.zwiftgame(\/dataES\/Misc\/v\d+\.txt)"/,
        (_, marker: string) =>
          [
            'invoke-virtual {p0}, Landroid/content/Context;->getDataDir()Ljava/io/File;',
            'move-result-object v0',
            'invoke-virtual {v0}, Ljava/io/File;->getAbsolutePath()Ljava/lang/String;',
            'move-result-object v0',
            `const-string v1, "${marker}"`,
            'invoke-virtual {v0, v1}, Ljava/lang/String;->concat(Ljava/lang/String;)Ljava/lang/String;',
            'move-result-object v0',
          ].join('\n    '),
      );
      if (source === downloader.source) {
        throw new Error(t('apk_expansion_version_patch_failed'));
      }
      await writeFile(downloader.path, source);
    }
    if (unzip && unzip.source.includes('/data/data/com.zwift.zwiftgame/')) {
      const source = unzip.source.replace(/const-string(?:\/jumbo)? v5, "\/data\/data\/com\.zwift\.zwiftgame\/"/, () =>
        [
          'iget-object v5, v1, Lcom/zwift/zwiftgame/downloader/ZwiftDownloaderActivity$AsyncUnzipTask;->mContext:Landroid/content/Context;',
          'invoke-virtual {v5}, Landroid/content/Context;->getDataDir()Ljava/io/File;',
          'move-result-object v5',
          'invoke-virtual {v5}, Ljava/io/File;->getAbsolutePath()Ljava/lang/String;',
          'move-result-object v5',
          'const-string v6, "/"',
          'invoke-virtual {v5, v6}, Ljava/lang/String;->concat(Ljava/lang/String;)Ljava/lang/String;',
          'move-result-object v5',
        ].join('\n    '),
      );
      if (source === unzip.source) {
        throw new Error(t('apk_expansion_path_patch_failed'));
      }
      await writeFile(unzip.path, source);
    }

    // Android can throw when Zwift asks for the installer of a package which isn't installed.
    const main = await readClass('ZwiftMainActivity.smali');
    if (!main) {
      return;
    }
    const installerLookup =
      /(const-string(?:\/jumbo)?\s+[pv]\d+,\s*)"com\.zwift\.zwiftgame"(?=\s+invoke-virtual[^\n]*PackageManager;->getInstallerPackageName\()/g;
    const activity = main.source.replaceAll(
      installerLookup,
      (_, instruction: string) => `${instruction}"${standaloneZwiftPackage}"`,
    );
    if (activity !== main.source) {
      await writeFile(main.path, activity);
    }
  }

  async signStandaloneZwift(
    input: string,
    output: string,
    obb: string,
    signer: ApkSigner,
    progress?: (fraction: number) => void,
  ) {
    await using handle = await open(input, 'r');
    const entries = await centralDirectory(handle);
    const dex = entries
      .values()
      .map((entry) => /^classes(\d*)\.dex$/.exec(entry.name))
      .filter((match) => match !== null)
      .map((match) => Number(match[1] || 1))
      .toArray();
    const next = Math.max(1, ...dex) + 1;
    const bootstrap = await readFile(resolve(packageRoot(), '../assets/android/zwift-setup.dex'));

    await this.rewrite(input, output, signer, {
      replace: new Map([[`classes${next}.dex`, bootstrap]]),
      store: new Map([[zwiftExpansionAsset, obb]]),
      progress,
    });
  }

  /** Zwift checks the Play Store expansion file's size before unpacking its assets. */
  async patchZwiftObb(input: string, output: string, pem: string, progress?: (fraction: number) => void) {
    const name = 'dataES/cacert.pem';
    const source = await open(input, 'r');

    try {
      const entries = await centralDirectory(source);
      const bundles = entries.filter((entry) => entry.name === name);
      const [bundle] = bundles;
      const limit = 1024 * 1024;

      if (!bundle || bundles.length !== 1 || bundle.size > limit || bundle.compressedSize > limit) {
        throw new Error(t('apk_expansion_certificate_required'));
      }

      const original = await readEntry(source, bundle, limit);
      const certificates = original
        .toString('ascii')
        .match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);

      if (!certificates?.length) {
        throw new Error(t('apk_expansion_certificate_invalid'));
      }

      // Keep the existing trust roots, omitting the descriptive text between PEM blocks to save space.
      const updated = Buffer.from([...new Set([...certificates, pem.trim()])].join('\n') + '\n', 'ascii');
      const { size } = await source.stat();
      await this.rewriteArchive(input, output, { replace: new Map([[name, updated]]), progress }, null, size);
    } finally {
      await source.close();
    }
  }

  /**
  Write a copy of the APK with entries dropped or replaced, then sign it with APK Signature Scheme v2.

  Entries are copied without recompressing. Stored entries are aligned: native libraries to 16 KB, so they map on
  any page size, and the rest to 4 bytes. Native libraries and the resource table are always stored, as Android
  requires when it maps them. The v1 JAR signature is dropped; the caller checks that the app's minimum SDK is 24
  or above, where v2 alone is enough.
  */
  async rewrite(input: string, output: string, signer: ApkSigner, options: RewriteOptions = {}) {
    await this.rewriteArchive(input, output, options, signer);
  }

  private async rewriteArchive(
    input: string,
    output: string,
    options: RewriteOptions,
    signer: ApkSigner | null,
    archiveSize?: number,
  ) {
    await using source = await open(input, 'r');
    const entries = await centralDirectory(source);
    const replace = options.replace ?? new Map<string, Uint8Array>();
    const tick = await this.progressMeter(input, options, signer !== null);

    await this.writeArchive(output, signer, archiveSize, tick, async (add) => {
      for (const entry of entries) {
        if (
          replace.has(entry.name) ||
          options.store?.has(entry.name) ||
          options.drop?.(entry.name) ||
          (signer && isJarSignature(entry.name))
        ) {
          continue;
        }

        const mustStore =
          signer && (entry.name === 'resources.arsc' || (entry.name.startsWith('lib/') && entry.name.endsWith('.so')));

        if (entry.method !== 0 && mustStore) {
          const data = await readEntry(source, entry);
          await add({ ...entry, method: 0, compressedSize: data.length }, data);
          continue;
        }

        const start = await dataOffset(source, entry);

        if (archiveSize !== undefined && start + entry.compressedSize > archiveSize) {
          throw new Error(t('apk_expansion_entry_truncated'));
        }

        await add(
          entry,
          entry.compressedSize === 0
            ? new Uint8Array()
            : createReadStream(input, { start, end: start + entry.compressedSize - 1, highWaterMark: chunkSize }),
        );
      }

      for (const [name, data] of replace) {
        const compressed = deflateRawSync(data, { level: 9 });
        await add(newZipEntry(name, 8, data.length, compressed.length, crc32(data)), compressed);
      }
      for (const [name, path] of options.store ?? []) {
        const { size } = await stat(path);
        let crc = 0;
        const source: AsyncIterable<Uint8Array> = createReadStream(path, { highWaterMark: chunkSize });
        for await (const bytes of source) {
          crc = crc32(bytes, crc);
          tick(bytes.length);
        }
        await add(newZipEntry(name, 0, size, size, crc), createReadStream(path, { highWaterMark: chunkSize }));
      }
    });
  }

  /**
  Count the bytes a rewrite reads and writes against an estimate of the whole: the copy of each entry, a checksum pass
  over each stored file, and, when signing, the digest pass over everything written.
  */
  private async progressMeter(input: string, options: RewriteOptions, signing: boolean) {
    const report = options.progress;

    if (!report) {
      return () => {};
    }

    let stored = 0;
    for (const path of options.store?.values() ?? []) {
      const { size } = await stat(path);
      stored += size;
    }
    const { size } = await stat(input);
    const written = size + stored;
    const work = Math.max(1, written * (signing ? 2 : 1) + stored);
    let done = 0;

    return (bytes: number) => {
      done += bytes;
      report(Math.min(1, done / work));
    };
  }

  private async writeArchive(
    output: string,
    signer: ApkSigner | null,
    archiveSize: number | undefined,
    tick: (bytes: number) => void,
    populate: (
      add: (entry: Omit<ZipEntry, 'localOffset'>, data: AsyncIterable<Uint8Array> | Uint8Array) => Promise<void>,
    ) => Promise<void>,
  ) {
    const target = await open(output, 'wx+', 0o600);

    try {
      const central: Array<Buffer> = [];
      let position = 0;

      const write = async (data: Uint8Array) => {
        if (archiveSize !== undefined && position + data.length > archiveSize) {
          throw new Error(t('apk_expansion_patch_size_limit'));
        }
        if (position + data.length >= 0xff_ff_ff_ff) {
          throw new Error(t('apk_archive_size_limit'));
        }
        const { bytesWritten } = await target.write(data, 0, data.length, position);
        if (bytesWritten !== data.length) {
          throw new Error(t('apk_archive_write_failed'));
        }
        position += data.length;
        tick(data.length);
      };

      const add = async (entry: Omit<ZipEntry, 'localOffset'>, data: AsyncIterable<Uint8Array> | Uint8Array) => {
        const alignment =
          signer && entry.method === 0
            ? entry.name.startsWith('lib/') && entry.name.endsWith('.so')
              ? pageAlignment
              : 4
            : 0;

        const headerEnd = position + 30 + entry.nameBytes.length;
        let extra = Buffer.alloc(0);

        if (alignment > 0) {
          const padding = (alignment - ((headerEnd + 6) % alignment)) % alignment;
          extra = Buffer.concat([u16(alignmentExtraId), u16(2 + padding), u16(alignment), Buffer.alloc(padding)]);
        }

        // Sizes go in the local header, so no entry needs a data descriptor.
        const flags = entry.flags & ~0x00_08;
        const offset = position;

        await write(
          Buffer.concat([
            u32(localSignature),
            u16(entry.versionNeeded),
            u16(flags),
            u16(entry.method),
            u16(entry.time),
            u16(entry.date),
            u32(entry.crc),
            u32(entry.compressedSize),
            u32(entry.size),
            u16(entry.nameBytes.length),
            u16(extra.length),
            entry.nameBytes,
            extra,
          ]),
        );

        if (data instanceof Uint8Array) {
          await write(data);
        } else {
          for await (const chunk of data) {
            await write(chunk);
          }
        }

        central.push(
          Buffer.concat([
            u32(centralSignature),
            u16(entry.versionMadeBy),
            u16(entry.versionNeeded),
            u16(flags),
            u16(entry.method),
            u16(entry.time),
            u16(entry.date),
            u32(entry.crc),
            u32(entry.compressedSize),
            u32(entry.size),
            u16(entry.nameBytes.length),
            u16(0),
            u16(0),
            u16(0),
            u16(entry.internalAttributes),
            u32(entry.externalAttributes),
            u32(offset),
            entry.nameBytes,
          ]),
        );
      };

      await populate(add);

      const directory = Buffer.concat(central);

      const eocd = (offset: number) =>
        Buffer.concat([
          u32(eocdSignature),
          u16(0),
          u16(0),
          u16(central.length),
          u16(central.length),
          u32(directory.length),
          u32(offset),
          u16(0),
        ]);

      if (archiveSize !== undefined) {
        // Place any padding before the directory so ZIP readers still find the end record at EOF.
        const directoryStart = archiveSize - directory.length - eocd(0).length;

        if (directoryStart < position) {
          throw new Error(t('apk_expansion_patch_size_limit'));
        }
        position = directoryStart;
      }

      if (signer) {
        // The digest covers the EOCD as if the directory started where the signing block will.
        const digest = await this.digest(target, position, [directory, eocd(position)], tick);
        await write(this.signingBlock(digest, signer));
      }

      const directoryStart = position;
      await write(directory);
      await write(eocd(directoryStart));
      await target.sync();
    } finally {
      await target.close();
    }
  }

  /** The CHUNKED_SHA256 digest of the zip entries (read from the file) and the given trailing sections. */
  private async digest(
    handle: FileHandle,
    entriesLength: number,
    sections: ReadonlyArray<Buffer>,
    tick: (bytes: number) => void,
  ) {
    const chunks: Array<Buffer> = [];

    const chunk = (bytes: Uint8Array) => {
      chunks.push(this.crypto.sha256Bytes(Buffer.from([0xa5]), u32(bytes.length), bytes));
    };

    for (let offset = 0; offset < entriesLength; offset += chunkSize) {
      const length = Math.min(chunkSize, entriesLength - offset);
      chunk(await readAt(handle, offset, length));
      tick(length);
    }

    for (const section of sections) {
      for (let offset = 0; offset < section.length; offset += chunkSize) {
        chunk(section.subarray(offset, offset + chunkSize));
      }
    }

    return this.crypto.sha256Bytes(Buffer.from([0x5a]), u32(chunks.length), ...chunks);
  }

  /** An APK Signing Block holding one v2 signer with one ECDSA P-256 signature. */
  private signingBlock(digest: Uint8Array, signer: ApkSigner) {
    const signedData = Buffer.concat([
      prefixed(prefixed(u32(ecdsaSha256), prefixed(digest))),
      prefixed(prefixed(signer.certificate)),
      prefixed(),
    ]);

    const signature = this.crypto.signEcdsaSha256(signedData, signer.key);

    const signerBlock = Buffer.concat([
      prefixed(signedData),
      prefixed(prefixed(u32(ecdsaSha256), prefixed(signature))),
      prefixed(signer.publicKey),
    ]);

    const value = prefixed(prefixed(signerBlock));
    const pair = Buffer.concat([u64(4 + value.length), u32(v2BlockId), value]);
    const size = pair.length + 8 + signingBlockMagic.length;

    return Buffer.concat([u64(size), pair, u64(size), signingBlockMagic]);
  }

  /**
  Give a decoded Zwift Companion APK a separate Android identity and the Zluggish launcher icon. Add the server
  certificate as a raw resource and trust it alongside the system's authorities.

  `folder` is the decoded APK: AndroidManifest.xml as text and a res folder with values/public.xml.
  */
  async patchDecoded(folder: string, certificatePem: string, rawName: string) {
    const manifestPath = resolve(folder, 'AndroidManifest.xml');
    let manifest = await readFile(manifestPath, 'utf8');
    const manifestPackage = /(<manifest\b[^>]*?\s+package=)(["'])([^"']+)\2/;

    const sourcePackage = manifestPackage.exec(manifest)?.[3];
    if (sourcePackage !== originalCompanionPackage && sourcePackage !== standaloneCompanionPackage) {
      throw new Error(t('companion_decoded_app_mismatch'));
    }

    const identifiers = new Map([[originalCompanionPackage, standaloneCompanionPackage]]);
    const renameIdentifier = (name: string) => {
      if (!name.startsWith(`${originalCompanionPackage}.`)) {
        return name;
      }
      const renamed = standaloneCompanionPackage + name.slice(originalCompanionPackage.length);
      identifiers.set(name, renamed);

      return renamed;
    };

    manifest = manifest
      .replace(manifestPackage, (_, start: string) => `${start}"${standaloneCompanionPackage}"`)
      // Relative class names still point at the original Java classes.
      .replaceAll(/<(?:application|activity(?:-alias)?|provider|receiver|service|instrumentation)\b[^>]*>/g, (tag) =>
        tag.replaceAll(
          /\bandroid:(name|targetActivity|parentActivityName|backupAgent|appComponentFactory|manageSpaceActivity|zygotePreloadName)=(["'])([^"']+)\2/g,
          (attribute, key: string, quote: string, name: string) => {
            if (name.includes('.') && !name.startsWith('.')) {
              return attribute;
            }
            const className = name.startsWith('.') ? name : `.${name}`;

            return `android:${key}=${quote}${sourcePackage}${className}${quote}`;
          },
        ),
      )
      .replaceAll(
        /\bandroid:(authorities|permission|readPermission|writePermission)=(["'])([^"']+)\2/g,
        (_, key: string, quote: string, value: string) =>
          `android:${key}=${quote}${value
            .split(';')
            .map((name) => renameIdentifier(name))
            .join(';')}${quote}`,
      )
      .replaceAll(/<(?:permission(?:-group|-tree)?|uses-permission(?:-sdk-23)?|action)\b[^>]*>/g, (tag) =>
        tag.replace(
          /\bandroid:name=(["'])([^"']+)\1/,
          (_, quote: string, name: string) => `android:name=${quote}${renameIdentifier(name)}${quote}`,
        ),
      );

    // The launcher shows a launcher activity's own label before the app's, so both carry the Zluggish name and icon.
    const icon = `@drawable/${androidLauncherIcon}`;
    const withBranding = (tag: string) =>
      tag
        .replaceAll(/\s+android:(?:label|icon|roundIcon)=(["'])[^"']*\1/g, '')
        .replace(
          /\s*(\/?>)$/,
          (_, end: string) =>
            ` android:label="Companion for Zluggish" android:icon="${icon}" android:roundIcon="${icon}"${end}`,
        );

    manifest = manifest
      .replace(/<application\b[^>]*>/, (tag) => withBranding(tag))
      .replaceAll(
        /(<(activity(?:-alias)?)\b[^>]*(?<!\/)>)([\s\S]*?<\/\2\s*>)/g,
        (component, tag: string, _kind, body: string) => {
          const launcherCategory = /<category\b[^>]*android:name=(["'])android\.intent\.category\.LAUNCHER\1/;
          if (!launcherCategory.test(body)) {
            return component;
          }

          const filters = body.replaceAll(/<intent-filter\b[^>]*>[\s\S]*?<\/intent-filter\s*>/g, (filter) =>
            launcherCategory.test(filter)
              ? filter.replace(/^<intent-filter\b[^>]*>/, (open) =>
                  open.replaceAll(/\s+android:(?:label|icon)=(["'])[^"']*\1/g, ''),
                )
              : filter,
          );

          return withBranding(tag) + filters;
        },
      );

    const res = await this.resourceFolder(folder);

    if (!res) {
      throw new Error(t('apk_public_resources_missing'));
    }
    const publicPath = resolve(res, 'values', 'public.xml');
    const originalPublicXml = await readFile(publicPath, 'utf8');
    let publicXml = originalPublicXml.replace(
      /(<resources\b[^>]*?\s+package=)(["'])([^"']+)\2/,
      (attribute, start: string, quote: string, name: string) =>
        name === originalCompanionPackage ? `${start}${quote}${standaloneCompanionPackage}${quote}` : attribute,
    );
    const config = /android:networkSecurityConfig="@xml\/([\w.]+)"/.exec(manifest)?.[1];
    const configName = config ?? 'zluggish_network_security_config';

    publicXml = declareAndroidResource(publicXml, 'raw', rawName);
    publicXml = await installAndroidLauncherIcon(res, publicXml);

    if (!config) {
      publicXml = declareAndroidResource(publicXml, 'xml', configName);
      manifest = manifest.replace(
        /<application\b/,
        () => `<application android:networkSecurityConfig="@xml/${configName}"`,
      );
    }

    await mkdir(resolve(res, 'raw'), { recursive: true });
    await mkdir(resolve(res, 'xml'), { recursive: true });
    await writeFile(resolve(res, 'raw', `${rawName}.pem`), certificatePem);
    await writeFile(
      resolve(res, 'xml', `${configName}.xml`),
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<network-security-config>',
        '  <base-config cleartextTrafficPermitted="false">',
        '    <trust-anchors>',
        `      <certificates src="@raw/${rawName}" />`,
        '      <certificates src="system" />',
        '    </trust-anchors>',
        '  </base-config>',
        '</network-security-config>',
        '',
      ].join('\n'),
    );
    await writeFile(publicPath, publicXml);
    await writeFile(manifestPath, manifest);

    const packagePath = resolve(res, '../package.json');
    const resourcePackage = await readFile(packagePath, 'utf8').catch(() => null);

    if (resourcePackage !== null) {
      await writeFile(
        packagePath,
        resourcePackage.replace(
          /("package_name"\s*:\s*)"com\.zwift\.android\.prod"/,
          (_, key: string) => `${key}"${standaloneCompanionPackage}"`,
        ),
      );
    }

    // Update package literals used for resource lookups and internal intent actions. Keep class names and store URLs.
    const smali = resolve(folder, 'smali');
    const decodedEntries = await readdir(folder);
    if (decodedEntries.includes('smali')) {
      for (const entry of await readdir(smali, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.smali')) {
          continue;
        }
        const path = resolve(entry.parentPath, entry.name);
        const source = await readFile(path, 'utf8');
        const updated = source.replaceAll(
          /^([ \t]*const-string(?:\/jumbo)?[ \t]+\w+,[ \t]*")([^"\r\n]+)"/gm,
          (_, start: string, value: string) =>
            start +
            (identifiers.get(value) ??
              value.replace(
                /^android\.resource:\/\/com\.zwift\.android\.prod\//,
                () => `android.resource://${standaloneCompanionPackage}/`,
              )) +
            '"',
        );

        if (updated !== source) {
          await writeFile(path, updated);
        }
      }
    }

    // The fitness view that the zoffline Companion patch also turns on, when the app still ships the flag.
    const remoteConfig = resolve(res, 'xml', 'remote_config_defaults.xml');
    const defaults = await readFile(remoteConfig, 'utf8').catch(() => null);

    if (defaults !== null) {
      await writeFile(
        remoteConfig,
        defaults.replace(/(<key>react_native_fitness_view<\/key>\s*<value>)false(<\/value>)/, '$1true$2'),
      );
    }
  }

  private async resourceFolder(folder: string): Promise<string | null> {
    for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
      if (!(entry.isFile() && entry.name === 'public.xml')) {
        continue;
      }

      const values = join(entry.parentPath, '..');

      if (entry.parentPath.endsWith('values')) {
        return resolve(values);
      }
    }

    return null;
  }

  async workspace(storage?: string) {
    if (storage) {
      await mkdir(storage, { recursive: true });

      return mkdtemp(join(storage, 'upload-'));
    }

    return mkdtemp(join(tmpdir(), 'zluggish-companion-'));
  }

  async removeTree(path: string) {
    await rm(path, { recursive: true, force: true });
  }

  /** Save an upload to path. Rejects, and removes the file, once it passes `limit` bytes. */
  async receive(body: ReadableStream<Uint8Array>, path: string, limit: number) {
    let received = 0;

    const count = new Transform({
      transform(chunk: Buffer, _encoding, next) {
        received += chunk.length;
        next(received > limit ? new Error(t('apk_upload_size_limit')) : null, chunk);
      },
    });

    try {
      // SAFETY: Hono hands over a WHATWG byte stream; Node and DOM stream declarations differ in their BYOB overloads.
      await pipeline(Readable.from(body), count, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }

    return received;
  }

  async appendUpload(path: string, chunk: string, offset: number) {
    const size = await this.size(path);
    if ((size ?? 0) !== offset) {
      throw new Error(t('apk_upload_size_mismatch'));
    }

    try {
      await pipeline(createReadStream(chunk), createWriteStream(path, { flags: 'a', mode: 0o600 }));
    } catch (error) {
      await truncate(path, offset);
      throw error;
    }
  }

  async retainUpload(workspace: string, destination: string) {
    const source = await open(resolve(workspace, 'upload'), 'r+');
    try {
      await source.sync();
    } finally {
      await source.close();
    }
    await mkdir(dirname(destination), { recursive: true });
    await rename(workspace, destination);
  }

  /** Copy a file, such as an upload kept beside the job that reads it. */
  async copy(from: string, to: string) {
    await copyFile(from, to);
  }

  /** Move a finished file into place, replacing what is there; copies when the folders are on different disks. */
  async publish(from: string, to: string) {
    await mkdir(dirname(to), { recursive: true });

    try {
      await rename(from, to);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EXDEV')) {
        throw error;
      }
      const staged = `${to}.${this.crypto.randomUUID()}.tmp`;

      try {
        await copyFile(from, staged);
        await rename(staged, to);
      } finally {
        await rm(staged, { force: true });
        await rm(from, { force: true });
      }
    }
  }

  async size(path: string) {
    const info = await stat(path).catch(() => null);

    return info?.size ?? null;
  }
}
