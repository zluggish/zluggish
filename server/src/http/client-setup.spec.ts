import { linuxSetupScript, macosSetupScript, setupFileName, windowsSetupScript } from '#src/http/client-setup';
import { CertificateRepository } from '#src/repositories/certificate.repository';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { legacyCertificateThumbprint } from '#src/services/tls.service';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

const crypto = new CryptoRepository();
const material = await new CertificateRepository().create({ serverId: '0123456789ab', years: 5, now: new Date() });
const facts = crypto.certificateFacts(material.cert);

const certificate = {
  ...facts,
  notBefore: facts.notBefore.toISOString(),
  notAfter: facts.notAfter.toISOString(),
};

const script = { pem: material.cert, certificate, address: '192.168.1.20', version: '1.2.3', now: new Date() };
const legacyBody = 'MIIEQTCCAymgAwIBAgIUVPfyk0BzcKB2eYhXZ+W9WZRY5HEwDQYJKoZIhvcNAQEL';
// Only the first line is needed to simulate an old entry in Zwift's PEM bundle.
const legacyPem = `${material.key}-----BEGIN CERTIFICATE-----
${legacyBody}
OLD
-----END CERTIFICATE-----
`;
const thumbprint = (pem: string) => crypto.certificateFacts(pem).thumbprint;

await test('the Windows script is plain ASCII with CRLF line ends and names the certificate it installs', () => {
  const text = windowsSetupScript(script);

  assert.match(text, /^<# : /);
  assert.ok(/^[ -~\r\n]*$/.test(text), 'ASCII only');
  assert.equal(text.split('\n').length, text.split('\r\n').length);
  assert.ok(text.includes(`$Thumbprint = '${facts.thumbprint}'`));
  assert.ok(text.includes("$ServerUnit = 'Zluggish server 0123456789ab'"));
  assert.ok(text.includes("$ServerAddress = '192.168.1.20'"));
  assert.ok(text.includes(material.cert.trim().replaceAll('\n', '\r\n')));
  assert.equal(setupFileName(certificate, 'bat'), `zluggish-zwift-${facts.thumbprint.slice(0, 8).toLowerCase()}.bat`);
  assert.ok(!windowsSetupScript({ ...script, address: '' }).includes('3. Points the Zwift host names'));
});

await test(
  'the Linux script trusts the certificate in Zwift and removes the shared one, idempotently',
  { skip: process.platform === 'win32' },
  (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'zluggish-setup-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = resolve(root, 'setup.sh');
    writeFileSync(file, linuxSetupScript({ ...script, address: '' }));
    execFileSync('/bin/sh', ['-n', file]);

    // Run as "root" with no trust store tools on the PATH, so only the Zwift folder changes.
    const bin = resolve(root, 'bin');
    mkdirSync(bin);
    writeFileSync(resolve(bin, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 });

    for (const tool of ['awk', 'cat', 'cp', 'cut', 'getent', 'mktemp', 'openssl', 'rm', 'sed', 'sort', 'tr']) {
      const path = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();

      if (path) {
        symlinkSync(path, resolve(bin, tool));
      }
    }

    const zwift = resolve(root, 'Zwift');
    mkdirSync(resolve(zwift, 'data'), { recursive: true });
    const bundle = resolve(zwift, 'data', 'cacert.pem');
    const other = '-----BEGIN CERTIFICATE-----\nOTHERCA\n-----END CERTIFICATE-----\n';
    // The old setup appended the shared certificate with its private key.
    writeFileSync(bundle, `${other}\n${legacyPem.replaceAll('\n', '\r\n')}`);

    const run = () => execFileSync('/bin/sh', [file, zwift], { env: { PATH: bin, HOME: root }, encoding: 'utf8' });

    assert.match(run(), /Updated .*cacert\.pem/);
    const once = readFileSync(bundle, 'utf8');
    run();
    const twice = readFileSync(bundle, 'utf8');

    assert.equal(twice, once);
    assert.ok(twice.startsWith(other));
    assert.ok(!twice.includes('PRIVATE KEY'));
    assert.ok(!twice.includes(legacyBody));
    assert.equal(twice.split(material.cert.trim()).length, 2);
    assert.ok(twice.includes(`# BEGIN Zluggish server certificate ${facts.thumbprint}`));
    assert.ok(existsSync(`${bundle}.zluggish-backup`));
  },
);

await test(
  "the macOS script trusts the certificate for TLS and replaces this server's earlier ones, idempotently",
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'zluggish-setup-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = resolve(root, 'setup.sh');
    writeFileSync(file, macosSetupScript({ ...script, address: '' }));
    execFileSync('/bin/sh', ['-n', file]);

    // The keychain holds the shared certificate, an earlier one of this server, one of another server and this one.
    const repository = new CertificateRepository();
    const earlier = await repository.create({ serverId: '0123456789ab', years: 5, now: new Date() });
    const another = await repository.create({ serverId: 'ba9876543210', years: 5, now: new Date() });
    const keychain = [earlier.cert, another.cert, material.cert];
    const stream = resolve(root, 'keychain.txt');
    writeFileSync(
      stream,
      `SHA-256 hash: 00\nSHA-1 hash: ${legacyCertificateThumbprint}\n${legacyPem}` +
        keychain.map((pem) => `SHA-256 hash: 00\nSHA-1 hash: ${thumbprint(pem)}\n${pem}`).join(''),
    );

    const bin = resolve(root, 'bin');
    mkdirSync(bin);
    writeFileSync(resolve(bin, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 });
    writeFileSync(resolve(bin, 'dscl'), `#!/bin/sh\necho 'NFSHomeDirectory: ${root}'\n`, { mode: 0o755 });
    const log = resolve(root, 'security.log');
    const added = resolve(root, 'added.pem');
    writeFileSync(
      resolve(bin, 'security'),
      [
        '#!/bin/sh',
        `echo "$*" >> '${log}'`,
        'case "$1" in',
        `  find-certificate) cat '${stream}' ;;`,
        `  add-trusted-cert) for last; do :; done; cp "$last" '${added}' ;;`,
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    for (const tool of ['awk', 'cat', 'cp', 'mktemp', 'openssl', 'rm', 'sed', 'tr']) {
      const path = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();

      if (path) {
        symlinkSync(path, resolve(bin, tool));
      }
    }

    const data = resolve(root, 'Library', 'Application Support', 'Zwift', 'data');
    mkdirSync(data, { recursive: true });
    const bundle = resolve(data, 'cacert.pem');
    const other = '-----BEGIN CERTIFICATE-----\nOTHERCA\n-----END CERTIFICATE-----\n';
    writeFileSync(bundle, `${other}\n${legacyPem}`);

    const run = () => execFileSync('/bin/sh', [file], { env: { PATH: bin, HOME: '/nonexistent' }, encoding: 'utf8' });

    assert.match(run(), /Updated .*Application Support\/Zwift\/data\/cacert\.pem/);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(
      calls
        .filter((call) => call.startsWith('delete-certificate'))
        .map((call) => call.match(/^delete-certificate -Z (\S+)/)?.[1] ?? '')
        .sort((a, b) => a.localeCompare(b)),
      [legacyCertificateThumbprint, thumbprint(earlier.cert)].sort((a, b) => a.localeCompare(b)),
    );
    assert.ok(
      calls.some((call) =>
        call.startsWith('add-trusted-cert -d -r trustRoot -p ssl -k /Library/Keychains/System.keychain'),
      ),
    );
    assert.equal(thumbprint(readFileSync(added, 'utf8')), facts.thumbprint);

    const once = readFileSync(bundle, 'utf8');
    run();

    assert.equal(readFileSync(bundle, 'utf8'), once);
    assert.ok(once.startsWith(other));
    assert.ok(!once.includes('PRIVATE KEY'));
    assert.ok(!once.includes(legacyBody));
    assert.ok(once.includes(`# BEGIN Zluggish server certificate ${facts.thumbprint}`));
  },
);
