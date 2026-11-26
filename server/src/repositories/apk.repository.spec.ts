import { packageRoot } from '#src/config/load';
import { ApkRepository, isJarSignature } from '#src/repositories/apk.repository';
import { CertificateRepository } from '#src/repositories/certificate.repository';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { binaryManifest, contents, listEntries, u32, zip } from '#tests/support/apk';

const repository = new ApkRepository();
const launcherIcon = readFileSync(resolve(packageRoot(), '../assets/android/zluggish-launcher.xml'));
const crypto = new CryptoRepository();
const certificates = new CertificateRepository();
const signerMaterial = await certificates.createApkSigner({ serverId: '0123456789ab', years: 50, now: new Date() });
const server = await certificates.create({ serverId: '0123456789ab', years: 5, now: new Date() });

const signer = {
  key: signerMaterial.key,
  certificate: Buffer.from(signerMaterial.cert.replaceAll(/-----[A-Z ]+-----|\s/g, ''), 'base64'),
  publicKey: crypto.certificatePublicKey(signerMaterial.cert),
};

/** Verify an APK Signature Scheme v2 signature from the spec, without the repository's code. */
function verifyV2(archive: Buffer) {
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  const directory = archive.readUInt32LE(eocd + 16);
  assert.equal(archive.toString('ascii', directory - 16, directory), 'APK Sig Block 42');
  const size = Number(archive.readBigUInt64LE(directory - 24));
  const block = directory - size - 8;
  assert.equal(Number(archive.readBigUInt64LE(block)), size);
  assert.equal(archive.readUInt32LE(block + 16), 0x71_09_87_1a);

  const prefixed = (buffer: Buffer, at: number) => {
    const length = buffer.readUInt32LE(at);

    return { value: buffer.subarray(at + 4, at + 4 + length), next: at + 4 + length };
  };

  const value = archive.subarray(block + 20, directory - 24);
  const signerBlock = prefixed(prefixed(value, 0).value, 0).value;
  const signedData = prefixed(signerBlock, 0);
  const signatures = prefixed(signerBlock, signedData.next);
  const publicKey = prefixed(signerBlock, signatures.next).value;
  const signature = prefixed(signatures.value, 0).value;
  assert.equal(signature.readUInt32LE(0), 0x02_01);
  const key = createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
  assert.ok(verify('sha256', signedData.value, key, prefixed(signature, 4).value), 'the signature verifies');

  const digest = prefixed(prefixed(prefixed(signedData.value, 0).value, 0).value, 4).value;
  const end = Buffer.from(archive.subarray(eocd));
  end.writeUInt32LE(block, 16);
  const chunks: Array<Buffer> = [];

  for (const section of [archive.subarray(0, block), archive.subarray(directory, eocd), end]) {
    for (let at = 0; at < section.length; at += 1024 * 1024) {
      const chunk = section.subarray(at, at + 1024 * 1024);
      chunks.push(
        createHash('sha256')
          .update(Buffer.from([0xa5]))
          .update(u32(chunk.length))
          .update(chunk)
          .digest(),
      );
    }
  }

  const expected = createHash('sha256')
    .update(Buffer.from([0x5a]))
    .update(u32(chunks.length))
    .update(Buffer.concat(chunks))
    .digest();

  assert.deepEqual(digest, expected, 'the digest covers the archive');

  return publicKey;
}

function workspace() {
  const folder = mkdtempSync(resolve(tmpdir(), 'zluggish-apk-'));

  return { folder, [Symbol.dispose]: () => rmSync(folder, { recursive: true, force: true }) };
}

const manifest = binaryManifest('com.zwift.android.prod', '3.91.0', 2175, 28);
const library = Buffer.alloc(40_000, 7);

const patched = zip([
  ['AndroidManifest.xml', manifest, true],
  ['META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\n'), true],
  ['META-INF/ANDROIDD.SF', Buffer.from('signature'), true],
  ['META-INF/ANDROIDD.RSA', Buffer.from('block'), false],
  ['classes.dex', Buffer.alloc(3000, 1), true],
  ['resources.arsc', Buffer.alloc(1001, 2), true],
  ['res/raw/cert-zwift-com.pem', Buffer.from(server.cert), true],
  ['res/raw/ride_on.wav', Buffer.alloc(501, 3), false],
  ['lib/arm64-v8a/libapp.so', library, true],
  ['lib/x86_64/libapp.so', library, false],
]);

await test('reads the package, version and minimum SDK from a binary manifest', async () => {
  using space = workspace();
  const path = resolve(space.folder, 'app.apk');
  writeFileSync(path, patched);

  assert.deepEqual(await repository.inspect(path), { kind: 'apk' });
  assert.deepEqual(await repository.manifest(path), {
    packageName: 'com.zwift.android.prod',
    versionName: '3.91.0',
    versionCode: 2175,
    minSdk: 28,
  });
  assert.deepEqual(await repository.trustedCertificates(path), ['res/raw/cert-zwift-com.pem']);
});

await test('tells a bundle of split APKs from an APK and from other files', async () => {
  using space = workspace();
  const bundle = resolve(space.folder, 'app.apks');
  const other = resolve(space.folder, 'notes.txt');
  writeFileSync(
    bundle,
    zip([
      ['base.apk', patched, false],
      ['split_config.arm64_v8a.apk', patched, true],
      ['info.json', Buffer.from('{}'), true],
    ]),
  );
  writeFileSync(other, 'not a zip');

  assert.deepEqual(await repository.inspect(bundle), {
    kind: 'bundle',
    apks: ['base.apk', 'split_config.arm64_v8a.apk'],
  });
  assert.deepEqual(await repository.inspect(other), { kind: 'unknown' });

  await repository.extractApks(bundle, resolve(space.folder, 'splits'));
  assert.deepEqual(readFileSync(resolve(space.folder, 'splits', 'split_config.arm64_v8a.apk')), patched);
});

await test('swaps the trusted certificate, aligns stored entries and signs with v2', async () => {
  using space = workspace();
  const input = resolve(space.folder, 'in.apk');
  const output = resolve(space.folder, 'out.apk');
  writeFileSync(input, patched);

  await repository.rewrite(input, output, signer, {
    replace: new Map([['res/raw/cert-zwift-com.pem', Buffer.from(server.cert)]]),
  });

  const archive = readFileSync(output);
  const entries = listEntries(archive);

  assert.deepEqual(verifyV2(archive), signer.publicKey);
  assert.equal(contents(archive, 'res/raw/cert-zwift-com.pem').toString('utf8'), server.cert);
  assert.deepEqual(contents(archive, 'AndroidManifest.xml'), manifest);
  assert.deepEqual(contents(archive, 'lib/arm64-v8a/libapp.so'), library);
  assert.ok(
    entries.keys().every((name) => !isJarSignature(name)),
    'the v1 signature is gone',
  );
  assert.ok(entries.has('res/raw/ride_on.wav'));

  for (const [name, entry] of entries) {
    assert.equal(entry.flags & 0x08, 0, `${name} needs no data descriptor`);

    if (name.endsWith('.so') || name === 'resources.arsc') {
      assert.equal(entry.method, 0, `${name} is stored`);
    }

    if (name.endsWith('.so')) {
      assert.equal(entry.start % 16_384, 0, `${name} starts on a 16 KB page`);
    } else if (entry.method === 0) {
      assert.equal(entry.start % 4, 0, `${name} is 4-byte aligned`);
    }
  }

  // A second pass over its own output, as after a certificate rotation, keeps the signer.
  const again = resolve(space.folder, 'again.apk');
  await repository.rewrite(output, again, signer, {
    replace: new Map([['res/raw/cert-zwift-com.pem', Buffer.from('x')]]),
  });
  assert.deepEqual(verifyV2(readFileSync(again)), signer.publicKey);
});

await test('points a decoded app at the certificate and declares the new resources', async () => {
  using space = workspace();
  const resources = resolve(space.folder, 'resources', 'package_1');
  const res = resolve(resources, 'res');
  mkdirSync(resolve(res, 'values'), { recursive: true });
  mkdirSync(resolve(res, 'xml'), { recursive: true });
  const smali = resolve(space.folder, 'smali', 'classes');
  mkdirSync(smali, { recursive: true });
  const code = resolve(smali, 'Example.smali');
  writeFileSync(
    code,
    [
      'const-string v1, "android.resource://com.zwift.android.prod/"',
      'const-string v1, "com.zwift.android.prod"',
      'const-string/jumbo v1, "com.zwift.android.prod.MESSAGE"',
      'const-string v1, "https://play.google.com/store/apps/details?id=com.zwift.android.prod"',
    ].join('\n'),
  );
  writeFileSync(resolve(resources, 'package.json'), '{"package_name":"com.zwift.android.prod"}');
  writeFileSync(
    resolve(space.folder, 'AndroidManifest.xml'),
    `<manifest package="com.zwift.android.prod">
  <permission android:name="com.zwift.android.prod.PERMISSION" />
  <uses-permission android:name="com.zwift.android.prod.PERMISSION" />
  <application android:networkSecurityConfig="@xml/network_security_config" android:label="Companion" android:roundIcon="@mipmap/old">
    <provider android:name=".Files" android:authorities="com.zwift.android.prod.files;com.example.other" />
    <receiver android:name="Message"><intent-filter><action android:name="com.zwift.android.prod.MESSAGE" /></intent-filter></receiver>
    <activity android:name="com.zwift.android.ui.Other" />
    <activity-alias android:name=".Launcher" android:targetActivity="com.zwift.android.ui.Other" android:label="@string/launcher" android:icon="@mipmap/old">
      <intent-filter android:label="@string/launcher" android:icon="@mipmap/old"><category android:name="android.intent.category.LAUNCHER" /></intent-filter>
      <intent-filter android:icon="@mipmap/link"><action android:name="android.intent.action.VIEW" /></intent-filter>
    </activity-alias>
  </application>
</manifest>`,
  );
  writeFileSync(
    resolve(res, 'values', 'public.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n<resources package="com.zwift.android.prod">\n  <public id="0x7f130008" type="raw" name="ride_on" />\n  <public id="0x7f18000d" type="xml" name="network_security_config" />\n  <public id="0x7f18000e" type="xml" name="remote_config_defaults" />\n</resources>\n',
  );
  writeFileSync(
    resolve(res, 'xml', 'network_security_config.xml'),
    '<network-security-config><domain-config><pin-set /></domain-config></network-security-config>',
  );
  writeFileSync(
    resolve(res, 'xml', 'remote_config_defaults.xml'),
    '<defaultsMap><entry>\n<key>react_native_fitness_view</key>\n<value>false</value>\n</entry></defaultsMap>',
  );

  await repository.patchDecoded(space.folder, server.cert, 'zluggish_server_cert');

  const manifest = readFileSync(resolve(space.folder, 'AndroidManifest.xml'), 'utf8');
  assert.match(manifest, /package="com\.zluggish\.companion"/);
  assert.match(manifest, /<provider android:name="com\.zwift\.android\.prod\.Files"/);
  assert.match(manifest, /android:authorities="com\.zluggish\.companion\.files;com\.example\.other"/);
  assert.match(manifest, /<receiver android:name="com\.zwift\.android\.prod\.Message"/);
  assert.match(manifest, /<uses-permission android:name="com\.zluggish\.companion\.PERMISSION"/);
  assert.match(manifest, /<action android:name="com\.zluggish\.companion\.MESSAGE"/);
  assert.equal(manifest.match(/android:icon="@drawable\/zluggish_launcher"/g)?.length, 2);
  // Android names the launcher entry after the activity first, so the app and its launcher both say Zluggish.
  assert.equal(manifest.match(/android:label="Companion for Zluggish"/g)?.length, 2);
  assert.doesNotMatch(manifest, /android:label="Companion"|@string\/launcher/);
  assert.match(manifest, /android:roundIcon="@drawable\/zluggish_launcher"/);
  assert.doesNotMatch(manifest, /@mipmap\/old/);
  assert.match(manifest, /<intent-filter android:icon="@mipmap\/link"/);
  assert.deepEqual(readFileSync(resolve(res, 'drawable', 'zluggish_launcher.xml')), launcherIcon);
  assert.match(readFileSync(resolve(resources, 'package.json'), 'utf8'), /"package_name":"com\.zluggish\.companion"/);
  const references = readFileSync(code, 'utf8');
  assert.match(references, /"android\.resource:\/\/com\.zluggish\.companion\/"/);
  assert.match(references, /"com\.zluggish\.companion"/);
  assert.match(references, /"com\.zluggish\.companion\.MESSAGE"/);
  assert.match(references, /details\?id=com\.zwift\.android\.prod"/);

  assert.equal(readFileSync(resolve(res, 'raw', 'zluggish_server_cert.pem'), 'utf8'), server.cert);
  const config = readFileSync(resolve(res, 'xml', 'network_security_config.xml'), 'utf8');
  assert.match(config, /<certificates src="@raw\/zluggish_server_cert" \/>/);
  assert.match(config, /<certificates src="system" \/>/);
  assert.doesNotMatch(config, /pin-set|src="user"/);
  const declared = readFileSync(resolve(res, 'values', 'public.xml'), 'utf8');
  assert.match(declared, /<resources package="com\.zluggish\.companion"/);
  assert.match(declared, /id="0x7f130009" type="raw" name="zluggish_server_cert"/);
  assert.match(declared, /type="drawable" name="zluggish_launcher"/);
  assert.match(readFileSync(resolve(res, 'xml', 'remote_config_defaults.xml'), 'utf8'), /<value>true<\/value>/);

  await repository.patchDecoded(space.folder, server.cert, 'zluggish_server_cert');
  assert.equal(readFileSync(resolve(res, 'values', 'public.xml'), 'utf8').match(/zluggish_server_cert/g)?.length, 1);
});

await test('gives an app without a network security config a new one', async () => {
  using space = workspace();
  const res = resolve(space.folder, 'res');
  mkdirSync(resolve(res, 'values'), { recursive: true });
  writeFileSync(
    resolve(space.folder, 'AndroidManifest.xml'),
    '<manifest package="com.zwift.android.prod">\n  <application android:label="Companion" />\n</manifest>\n',
  );
  writeFileSync(
    resolve(res, 'values', 'public.xml'),
    '<resources>\n  <public id="0x7f080001" type="drawable" name="icon" />\n</resources>\n',
  );

  await repository.patchDecoded(space.folder, server.cert, 'zluggish_server_cert');

  assert.match(
    readFileSync(resolve(space.folder, 'AndroidManifest.xml'), 'utf8'),
    /<application android:networkSecurityConfig="@xml\/zluggish_network_security_config" android:label/,
  );
  const declared = readFileSync(resolve(res, 'values', 'public.xml'), 'utf8');
  assert.match(declared, /id="0x7f090000" type="raw" name="zluggish_server_cert"/);
  assert.match(declared, /id="0x7f0a0000" type="xml" name="zluggish_network_security_config"/);
});

await test('patches a Zwift expansion file at its original size while preserving assets and trust roots', async () => {
  using space = workspace();
  const input = resolve(space.folder, 'main.obb');
  const output = resolve(space.folder, 'patched.obb');
  const bundle = 'dataES/cacert.pem';
  const asset = 'dataES/game.dat';
  const original = zip([
    [bundle, Buffer.from(signerMaterial.cert + '# certificate description\n'.repeat(128)), false],
    [asset, library, true],
  ]);
  writeFileSync(input, original);

  await repository.patchZwiftObb(input, output, server.cert);

  const patched = readFileSync(output);
  assert.equal(patched.length, original.length);
  assert.deepEqual(contents(patched, asset), library);
  assert.equal(contents(patched, bundle).toString(), signerMaterial.cert.trim() + '\n' + server.cert.trim() + '\n');
});

await test('rejects an archive without the Zwift game certificate bundle', async () => {
  using space = workspace();
  const input = resolve(space.folder, 'fake.obb');
  writeFileSync(input, patched);

  await assert.rejects(
    repository.patchZwiftObb(input, resolve(space.folder, 'patched.obb'), server.cert),
    /needs one Zwift certificate bundle/,
  );
});

await test(
  'extracts an APKM expansion whose ZIP64 local and central offsets exceed 4 GiB',
  {
    skip: process.platform === 'win32' ? 'The fixture relies on sparse writes.' : false,
  },
  async () => {
    using space = workspace();
    const input = resolve(space.folder, 'large.apkm');
    const output = resolve(space.folder, 'out.obb');
    const name = 'main.123.com.zwift.zwiftgame.obb';
    const source = Buffer.from('sample expansion');
    const archive = zip([[name, source, true]]);
    const eocd = archive.subarray(-22);
    const directoryOffset = eocd.readUInt32LE(16);
    const central = archive.subarray(directoryOffset, -22);
    const localOffset = 5 * 1024 ** 3;
    const centralOffset = localOffset + directoryOffset;
    const extra = Buffer.alloc(12);
    extra.writeUInt16LE(1, 0);
    extra.writeUInt16LE(8, 2);
    extra.writeBigUInt64LE(BigInt(localOffset), 4);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(0xff_ff_ff_ff, 42);
    eocd.writeUInt32LE(0xff_ff_ff_ff, 16);

    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06_06_4b_50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeBigUInt64LE(1n, 24);
    record.writeBigUInt64LE(1n, 32);
    record.writeBigUInt64LE(BigInt(central.length + extra.length), 40);
    record.writeBigUInt64LE(BigInt(centralOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07_06_4b_50, 0);
    locator.writeBigUInt64LE(BigInt(centralOffset + central.length + extra.length), 8);
    locator.writeUInt32LE(1, 16);

    await using handle = await open(input, 'wx');
    await handle.write(
      Buffer.concat([archive.subarray(0, directoryOffset), central, extra, record, locator, eocd]),
      0,
      archive.length + extra.length + record.length + locator.length,
      localOffset,
    );

    assert.equal(await repository.extractZwiftObb(input, output, 1024, new AbortController().signal), name);
    assert.deepEqual(readFileSync(output), source);
  },
);

await test('gives the standalone Zwift build its own package and starts setup before the original launcher', async () => {
  using space = workspace();
  const manifest = resolve(space.folder, 'AndroidManifest.xml');
  const resources = resolve(space.folder, 'resources/package_1');
  mkdirSync(resources, { recursive: true });
  writeFileSync(resolve(resources, 'package.json'), '{"package_name":"com.zwift.zwiftgame"}');
  const values = resolve(resources, 'res/values');
  mkdirSync(values, { recursive: true });
  const publicXml = resolve(values, 'public.xml');
  writeFileSync(publicXml, '<resources><public id="0x7f010001" type="drawable" name="original" /></resources>');
  writeFileSync(
    manifest,
    `<manifest package="com.zwift.zwiftgame">
  <permission android:name="com.zwift.zwiftgame.PRIVATE" />
  <application android:name=".App" android:label="@string/app_name" android:icon="@mipmap/original" android:roundIcon="@mipmap/round">
    <provider android:name=".Files" android:authorities="com.zwift.zwiftgame.files" />
    <activity android:name=".Game" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>`,
  );

  await repository.configureDecodedZwift(space.folder, 169_052);

  const result = readFileSync(manifest, 'utf8');
  assert.match(result, /package="com\.zluggish\.zwift"/);
  assert.match(result, /android:label="Zwift for Zluggish"/);
  assert.match(result, /android:icon="@drawable\/zluggish_launcher"/);
  assert.match(result, /android:roundIcon="@drawable\/zluggish_launcher"/);
  assert.match(readFileSync(publicXml, 'utf8'), /id="0x7f010002" type="drawable" name="zluggish_launcher"/);
  assert.deepEqual(readFileSync(resolve(resources, 'res/drawable/zluggish_launcher.xml')), launcherIcon);
  assert.match(result, /android:name="com\.zluggish\.zwift\.PRIVATE"/);
  assert.match(result, /android:name="com\.zwift\.zwiftgame\.App"/);
  assert.match(result, /android:authorities="com\.zluggish\.zwift\.files"/);
  assert.match(result, /android:name="com\.zluggish\.zwift\.bootstrap\.SetupActivity"/);
  assert.match(result, /android:name="zluggish\.launcher" android:value="com\.zwift\.zwiftgame\.Game"/);
  assert.match(result, /android:name="zluggish\.expansion" android:value="main\.169052\.com\.zluggish\.zwift\.obb"/);
  assert.equal(result.matchAll(/android\.intent\.category\.LAUNCHER/g).toArray().length, 1);
  assert.match(readFileSync(resolve(resources, 'package.json'), 'utf8'), /"package_name":"com\.zluggish\.zwift"/);
});

await test('uses the renamed app for Zwift expansion, private storage, and installer lookups', async () => {
  using space = workspace();
  const folder = resolve(space.folder, 'smali/classes2/com/zwift/zwiftgame/vending/expansion/downloader');
  const helper = resolve(folder, 'Helpers.smali');
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    helper,
    `.field public static final PACKAGE_NAME:Ljava/lang/String; = "com.zwift.zwiftgame"
.method public static getExpansionAPKFileName(ZI)Ljava/lang/String;
    const-string p1, ".com.zwift.zwiftgame.obb"
    return-object p1
.end method
.method public static unrelated()Ljava/lang/String;
    const-string v0, ".com.zwift.zwiftgame.obb"
    return-object v0
.end method`,
  );

  const main = resolve(space.folder, 'smali/classes/com/zwift/zwiftgame/ZwiftMainActivity.smali');
  mkdirSync(dirname(main), { recursive: true });
  writeFileSync(
    main,
    `    const-string v4, "com.zwift.zwiftgame"

    invoke-virtual {v3, v4}, Landroid/content/pm/PackageManager;->getInstallerPackageName(Ljava/lang/String;)Ljava/lang/String;`,
  );
  const downloaderFolder = resolve(dirname(main), 'downloader');
  const downloader = resolve(downloaderFolder, 'ZwiftDownloaderActivity.smali');
  const unzip = resolve(downloaderFolder, 'ZwiftDownloaderActivity$AsyncUnzipTask.smali');
  mkdirSync(downloaderFolder);
  writeFileSync(downloader, '    const-string v0, "/data/data/com.zwift.zwiftgame/dataES/Misc/v169052.txt"\n');
  writeFileSync(unzip, '    const-string v5, "/data/data/com.zwift.zwiftgame/"\n');

  await repository.configureZwiftPackageLookups(space.folder);

  assert.match(readFileSync(main, 'utf8'), /const-string v4, "com\.zluggish\.zwift"/);
  const marker = readFileSync(downloader, 'utf8');
  assert.match(marker, /invoke-virtual \{p0\}, Landroid\/content\/Context;->getDataDir\(\)/);
  assert.match(marker, /const-string v1, "\/dataES\/Misc\/v169052\.txt"/);
  const extraction = readFileSync(unzip, 'utf8');
  assert.match(extraction, /invoke-virtual \{v5\}, Landroid\/content\/Context;->getDataDir\(\)/);
  assert.match(extraction, /const-string v6, "\/"/);
  assert.doesNotMatch(marker + extraction, /\/data\/data\/com\.zwift\.zwiftgame/);

  const result = readFileSync(helper, 'utf8');
  assert.match(result, /getExpansionAPKFileName[^\n]*\s+const-string p1, "\.com\.zluggish\.zwift\.obb"/);
  assert.match(result, /const-string v0, "\.com\.zwift\.zwiftgame\.obb"/);
  assert.match(result, /PACKAGE_NAME:Ljava\/lang\/String; = "com\.zwift\.zwiftgame"/);
});

await test('signs a standalone APK with the original dex, bootstrap dex and a stored OBB', async () => {
  using space = workspace();
  const input = resolve(space.folder, 'renamed.apk');
  const output = resolve(space.folder, 'standalone.apk');
  const obb = resolve(space.folder, 'patched.obb');
  const gameDex = Buffer.from('game dex');
  const expansionData = Buffer.from('patched expansion');
  writeFileSync(
    input,
    zip([
      ['AndroidManifest.xml', binaryManifest('com.zluggish.zwift', '1.126.0', 169_052, 28), false],
      ['classes.dex', gameDex, true],
    ]),
  );
  writeFileSync(obb, expansionData);

  await repository.signStandaloneZwift(input, output, obb, signer);

  const apk = readFileSync(output);
  assert.deepEqual(verifyV2(apk), signer.publicKey);
  assert.deepEqual(await repository.manifest(output), {
    packageName: 'com.zluggish.zwift',
    versionName: '1.126.0',
    versionCode: 169_052,
    minSdk: 28,
  });
  assert.deepEqual(contents(apk, 'classes.dex'), gameDex);
  assert.match(contents(apk, 'classes2.dex').toString('ascii', 0, 8), /^dex\n/);
  assert.deepEqual(contents(apk, 'assets/zluggish/expansion.obb'), expansionData);
  assert.equal(listEntries(apk).get('assets/zluggish/expansion.obb')?.method, 0);
});
