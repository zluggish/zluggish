import { validateConfig } from '#src/config/index';
import { packageRoot } from '#src/config/load';
import { readArchivedFile } from '#src/migrations/backup-archive';
import { CertificateRepository } from '#src/repositories/certificate.repository';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { openRuntime } from '#src/runtime';
import { legacyDatabase } from '#tests/support/legacy';
import { ManagementService } from '#src/services/management.service';
import { TlsService, legacyCertificateThumbprint } from '#src/services/tls.service';
import { createWebApp } from '#src/http/web-app';
import { mediumWeb } from '#tests/medium/support';
import { runtimeFixture } from '#tests/support/runtime';
import { responseStatus } from '#tests/support/html';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

async function json(request: Response | Promise<Response>): Promise<any> {
  const response = await request;

  return response.json();
}

async function text(request: Response | Promise<Response>) {
  const response = await request;

  return response.text();
}

async function administrator(f: ReturnType<typeof runtimeFixture>) {
  const service = f.effects.runSync(ManagementService);

  return f.effects.runPromise(
    service.setup({
      mode: 'new',
      key: f.effects.runSync(service.issueSetupKey())!,
      username: 'owner',
      first_name: 'First',
      last_name: 'Rider',
      password: 'test-password',
    }),
  );
}

await test('a server without riders generates its own certificate on first start', async (t) => {
  const f = runtimeFixture(t);
  const tls = f.effects.runSync(TlsService);
  const warnings = t.mock.method(f.world.lifecycle.log, 'warn');

  assert.equal(tls.material(), null);
  await f.effects.runPromise(tls.start());

  assert.equal(tls.mode(), 'managed');
  assert.ok(existsSync(resolve(f.config.storageDir, 'tls', 'zwift-server.pem')));
  const status = await f.effects.runPromise(tls.status());
  assert.equal(status.certificate?.key, 'ECDSA P-256');
  assert.deepEqual(status.certificate?.hosts, ['*.zwift.com', 'zwift.com']);
  assert.equal(new Date(status.certificate.notAfter).getUTCFullYear(), new Date().getUTCFullYear() + 5);
  assert.equal(warnings.mock.callCount(), 0);
});

await test('startup backs up legacy storage and generates a certificate for migrated riders', async (t) => {
  const storage = mkdtempSync(resolve(tmpdir(), 'zluggish-tls-migration-'));
  t.after(() => rmSync(storage, { recursive: true, force: true }));
  const db = legacyDatabase(storage);
  db.exec("INSERT INTO user (player_id, username, first_name, last_name) VALUES (42, 'existing', 'Existing', 'Rider')");
  db.close();
  renameSync(resolve(storage, 'zluggish.db'), resolve(storage, 'zwift-offline.db'));
  writeFileSync(resolve(storage, 'server-ip.txt'), '192.0.2.42');

  const config = validateConfig({ storageDir: storage });
  const assets = resolve(packageRoot(), '../assets');
  const { runtime, close } = await openRuntime(config, assets);

  try {
    const tls = runtime.effects.runSync(TlsService);
    assert.equal(runtime.accounts.list().length, 1);
    assert.equal(tls.mode(), 'managed');
    assert.ok(tls.material());
    assert.ok(existsSync(resolve(storage, 'tls', 'zwift-server.pem')));

    const directory = resolve(storage, 'backups');
    const backup = readdirSync(directory).find((file) => file.startsWith('pre-migration-'));
    assert.ok(backup);
    assert.equal(readArchivedFile(resolve(directory, backup), 'server-ip.txt'), '192.0.2.42');
  } finally {
    await close();
  }
});

await test('an explicitly supplied shared certificate still warns and cannot be downloaded', async (t) => {
  const repository = new CertificateRepository();
  const material = await repository.create({ serverId: '0123456789ab', years: 5, now: new Date() });
  t.mock.method(CertificateRepository.prototype, 'read', () => material);

  // Simulate the old fingerprint without keeping a copy of the shared certificate or key in the test.
  const cryptoRepository = new CryptoRepository();
  const facts = cryptoRepository.certificateFacts.bind(cryptoRepository);
  t.mock.method(CryptoRepository.prototype, 'certificateFacts', (pem: string) => {
    const value = facts(pem);

    return pem === material.cert ? { ...value, thumbprint: legacyCertificateThumbprint } : value;
  });

  const f = runtimeFixture(t);
  const tls = f.effects.runSync(TlsService);
  const warnings = t.mock.method(f.world.lifecycle.log, 'warn');
  await f.effects.runPromise(tls.start());

  assert.equal(tls.mode(), 'legacy');
  assert.deepEqual(
    warnings.mock.calls.map((call) => call.arguments[0]),
    ['tls.legacy_certificate'],
  );
  assert.match(await text(f.app.request('/login/')), /shared Zwift certificate, whose private key is public/);

  const owner = await administrator(f);
  const web = mediumWeb(f, owner);
  const status = await json(web.request('/api/tls'));
  assert.equal(status.mode, 'legacy');
  assert.equal(await responseStatus(web.request('/api/tls/certificate')), 409);
  assert.equal(await responseStatus(web.request('/api/tls/setup/windows')), 409);
  assert.equal(await responseStatus(web.request('/api/manage/companion/app', 'PUT', Buffer.from('apk'))), 409);
  assert.equal(
    await responseStatus(web.request('/api/manage/zwift-android/uploads', 'POST', { name: 'zwift.apkm', size: 1 })),
    409,
  );

  await f.effects.runPromise(tls.rotate(crypto.randomUUID()));
  assert.doesNotMatch(await text(f.app.request('/login/')), /shared Zwift certificate/);
});

await test('riders download the certificate and setup scripts, and only administrators rotate it', async (t) => {
  const f = runtimeFixture(t);
  const owner = await administrator(f);
  const rider = await f.accounts.create('Regular Rider', 'test-password', 'rider');
  const admin = mediumWeb(f, owner);
  const web = mediumWeb(f, rider);
  const tls = f.effects.runSync(TlsService);
  await f.effects.runPromise(tls.start());
  const applied: Array<string> = [];
  tls.subscribe((material) => {
    applied.push(material.cert);
  });

  assert.equal(await responseStatus(createWebApp(f).request('http://local:8080/api/tls')), 401);
  const before = await json(web.request('/api/tls'));
  assert.equal(before.mode, 'managed');

  const operation = crypto.randomUUID();
  assert.equal(await responseStatus(web.request('/api/manage/server/certificate', 'POST', { operation })), 403);
  const rotated = await json(admin.request('/api/manage/server/certificate', 'POST', { operation }));
  assert.equal(rotated.mode, 'managed');
  assert.notEqual(rotated.certificate.fingerprint256, before.certificate.fingerprint256);
  const retried = await json(admin.request('/api/manage/server/certificate', 'POST', { operation }));
  assert.equal(retried.certificate.fingerprint256, rotated.certificate.fingerprint256);

  const next = await json(admin.request('/api/manage/server/certificate', 'POST', { operation: crypto.randomUUID() }));

  assert.notEqual(next.certificate.fingerprint256, rotated.certificate.fingerprint256);
  assert.equal(applied.length, 2);
  // Rotation keeps the server's name, so setup scripts find what they installed before.
  assert.equal(next.certificate.subject, rotated.certificate.subject);

  const pem = await web.request('/api/tls/certificate');
  assert.equal(pem.status, 200);
  assert.match(pem.headers.get('Content-Disposition')!, /attachment; filename="zluggish-zwift-[\da-f]{8}\.crt"/);
  const pemText = await pem.text();
  assert.equal(new X509Certificate(pemText).fingerprint256, next.certificate.fingerprint256);
  const der = await web.request('/api/tls/certificate?format=der');
  assert.equal(der.headers.get('Content-Type'), 'application/pkix-cert');
  assert.equal(
    new X509Certificate(Buffer.from(await der.arrayBuffer())).fingerprint256,
    next.certificate.fingerprint256,
  );

  const windows = await web.request('/api/tls/setup/windows?address=192.168.1.20');
  assert.equal(windows.status, 200);
  assert.match(windows.headers.get('Content-Disposition')!, /\.bat"$/);
  const bat = await windows.text();
  assert.ok(bat.includes(`$Thumbprint = '${next.certificate.thumbprint}'`));
  assert.ok(bat.includes("$ServerAddress = '192.168.1.20'"));
  assert.doesNotMatch(bat, /WARNING/);

  const linux = await text(web.request('/api/tls/setup/linux?address=fd00::20'));
  assert.ok(linux.startsWith('#!/bin/sh'));
  assert.ok(linux.includes("SERVER_ADDRESS='fd00::20'"));
  assert.equal(await responseStatus(web.request("/api/tls/setup/linux?address=1.2.3.4'; rm -rf /")), 400);
  const macos = await web.request('/api/tls/setup/macos?address=192.168.1.20');
  assert.match(macos.headers.get('Content-Disposition')!, /filename="zluggish-zwift-[\da-f]{8}\.sh"/);
  const mac = await macos.text();
  assert.ok(mac.includes('# Zluggish client setup for macOS'));
  assert.ok(mac.includes(`THUMBPRINT='${next.certificate.thumbprint}'`));
  assert.equal(await responseStatus(web.request('/api/tls/setup/android')), 400);
});
