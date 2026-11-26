// Small APK fixtures: a binary manifest and zip archives, built by hand so tests need no Android tools.
import assert from 'node:assert/strict';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export function u16(value: number) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);

  return bytes;
}

export function u32(value: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);

  return bytes;
}

/** A minimal binary AndroidManifest.xml, as aapt2 writes one: a UTF-16 string pool, resource map and elements. */
export function binaryManifest(
  packageName: string,
  versionName: string,
  versionCode: number,
  minSdk: number,
  split?: string,
) {
  // Attribute names first, so their indices line up with the resource map.
  const strings = [
    'versionCode',
    'versionName',
    'minSdkVersion',
    'package',
    'manifest',
    'uses-sdk',
    packageName,
    versionName,
    ...(split ? ['split', split] : []),
  ];

  const index = (value: string) => strings.indexOf(value);
  const offsets: Array<Buffer> = [];
  const data: Array<Buffer> = [];
  let length = 0;

  for (const value of strings) {
    offsets.push(u32(length));
    const encoded = Buffer.concat([u16(value.length), Buffer.from(value, 'utf16le'), u16(0)]);
    data.push(encoded);
    length += encoded.length;
  }

  const body = Buffer.concat(data);
  const padded = Buffer.concat([body, Buffer.alloc((4 - (body.length % 4)) % 4)]);
  const start = 28 + offsets.length * 4;

  const pool = Buffer.concat([
    u16(1),
    u16(28),
    u32(start + padded.length),
    u32(strings.length),
    u32(0),
    u32(0),
    u32(start),
    u32(0),
    ...offsets,
    padded,
  ]);

  const ids = [0x01_01_02_1b, 0x01_01_02_1c, 0x01_01_02_0c];
  const map = Buffer.concat([u16(0x01_80), u16(8), u32(8 + ids.length * 4), ...ids.map((id) => u32(id))]);

  const attribute = (name: string, type: number, value: number) =>
    Buffer.concat([
      u32(0xff_ff_ff_ff),
      u32(index(name)),
      u32(type === 3 ? value : 0xff_ff_ff_ff),
      u16(8),
      Buffer.from([0, type]),
      u32(value),
    ]);

  const element = (name: string, attributes: Array<Buffer>) => {
    const content = Buffer.concat([
      u32(0xff_ff_ff_ff),
      u32(index(name)),
      u16(20),
      u16(20),
      u16(attributes.length),
      u16(0),
      u16(0),
      u16(0),
      ...attributes,
    ]);

    return Buffer.concat([u16(0x01_02), u16(16), u32(16 + content.length), u32(1), u32(0xff_ff_ff_ff), content]);
  };

  const chunks = Buffer.concat([
    pool,
    map,
    element('manifest', [
      attribute('versionCode', 0x10, versionCode),
      attribute('versionName', 3, index(versionName)),
      attribute('package', 3, index(packageName)),
      ...(split ? [attribute('split', 3, index(split))] : []),
    ]),
    element('uses-sdk', [attribute('minSdkVersion', 0x10, minSdk)]),
  ]);

  return Buffer.concat([u16(3), u16(8), u32(8 + chunks.length), chunks]);
}

/** A zip archive. Deflated entries use a data descriptor, as many tools write them, to check that copies drop it. */
export function zip(entries: Array<[name: string, data: Buffer, deflate: boolean]>) {
  const local: Array<Buffer> = [];
  const central: Array<Buffer> = [];
  let offset = 0;

  for (const [name, data, deflate] of entries) {
    const stored = deflate ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name, 'utf8');
    const flags = deflate ? 0x08 : 0;
    const crc = crc32(data);

    const header = Buffer.concat([
      u32(0x04_03_4b_50),
      u16(20),
      u16(flags),
      u16(deflate ? 8 : 0),
      u16(0),
      u16(0x21),
      u32(deflate ? 0 : crc),
      u32(deflate ? 0 : stored.length),
      u32(deflate ? 0 : data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
    ]);

    const descriptor = deflate
      ? Buffer.concat([u32(0x08_07_4b_50), u32(crc), u32(stored.length), u32(data.length)])
      : Buffer.alloc(0);

    local.push(header, stored, descriptor);
    central.push(
      Buffer.concat([
        u32(0x02_01_4b_50),
        u16(20),
        u16(20),
        u16(flags),
        u16(deflate ? 8 : 0),
        u16(0),
        u16(0x21),
        u32(crc),
        u32(stored.length),
        u32(data.length),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      ]),
    );
    offset += header.length + stored.length + descriptor.length;
  }

  const directory = Buffer.concat(central);

  return Buffer.concat([
    ...local,
    directory,
    u32(0x06_05_4b_50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(directory.length),
    u32(offset),
    u16(0),
  ]);
}

/** Each entry's name, method and where its data starts, read independently of the repository. */
export function listEntries(archive: Buffer) {
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  const count = archive.readUInt16LE(eocd + 10);
  let at = archive.readUInt32LE(eocd + 16);
  const entries = new Map<string, { method: number; start: number; size: number; flags: number }>();

  for (let index = 0; index < count; index++) {
    const nameLength = archive.readUInt16LE(at + 28);
    const name = archive.toString('utf8', at + 46, at + 46 + nameLength);
    const local = archive.readUInt32LE(at + 42);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    entries.set(name, {
      method: archive.readUInt16LE(at + 10),
      start,
      size: archive.readUInt32LE(at + 20),
      flags: archive.readUInt16LE(local + 6),
    });
    at += 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  }

  return entries;
}

export function contents(archive: Buffer, name: string) {
  const entry = listEntries(archive).get(name);

  assert.ok(entry, `${name} is in the archive`);
  const data = archive.subarray(entry.start, entry.start + entry.size);

  return entry.method === 8 ? inflateRawSync(data) : data;
}
