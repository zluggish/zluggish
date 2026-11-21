import { createWebApp } from '#src/http/web-app';
import { createCdn } from '#src/node/network/cdn';
import { ManagementService } from '#src/services/management.service';
import { responseStatus } from '#tests/support/html';
import { runtimeFixture } from '#tests/support/runtime';
import { Effect } from 'effect';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { IncomingMessage } from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { Socket } from 'node:net';
import { test } from 'node:test';

await test('the admin update control gates version checks and downloads on both CDN entry points', async (t) => {
  const f = runtimeFixture(t);
  const service = f.effects.runSync(ManagementService);

  const owner = await f.effects.runPromise(
    service.setup({
      mode: 'new',
      key: f.effects.runSync(service.issueSetupKey())!,
      username: 'owner',
      first_name: 'First',
      last_name: 'Rider',
      password: 'test-password',
    }),
  );

  const rider = await f.accounts.create('Second Rider', 'test-password', 'rider');
  const admin = Effect.runSync(service.sessions.create(f.accounts.identityOf(owner)));
  const regular = Effect.runSync(service.sessions.create(f.accounts.identityOf(rider)));
  const web = createWebApp(f);
  const cdn = createCdn(f);
  const root = '/gameassets/Zwift_Updates_Root/';
  const version = `${root}Zwift_ver_cur.xml`;
  const macVersion = `${root}ZwiftMac_ver_cur.xml`;
  const unknown = `${root}Zwift_ver_cur.999999.xml`;
  const manifest = `${root}Zwift_test_manifest.xml`;
  const launcher = '/static/web/launcher/app/ZwiftSetup.zip';
  const macLauncher = '/app/MacUpdate/Launcher.zip';

  const upstream = t.mock.method(
    https,
    'request',
    (_url: string, _options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
      const response = new IncomingMessage(new Socket());
      response.statusCode = 200;
      response.headers = { 'cache-control': 'public, max-age=600' };
      const request = new EventEmitter();

      return Object.assign(request, {
        setTimeout() {},
        end() {
          callback(response);
          response.push('from Zwift');
          response.push(null);
        },
      });
    },
  );

  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const patch = (allowed: boolean, session = admin, csrf = session.session.csrf) =>
    web.request('/api/manage/server/zwift-updates', {
      method: 'PATCH',
      headers: {
        Cookie: `zluggish_web_session=${session.id}`,
        Origin: 'http://localhost',
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ allowed }),
    });

  const state = async (app = web) => {
    const response = await app.request('/api/manage/settings', {
      headers: { Cookie: `zluggish_web_session=${admin.id}` },
    });

    assert.equal(response.status, 200);

    const body: unknown = await response.json();
    assert.ok(body && typeof body === 'object' && 'zwiftUpdates' in body);

    return body.zwiftUpdates;
  };

  assert.deepEqual(await state(), { allowed: false, available: true });
  const bundled = await cdn.request(version);
  assert.equal(bundled.status, 200);
  assert.equal(bundled.headers.get('Cache-Control'), 'no-store');
  const xml = await bundled.text();
  const build = /\bversion="1\.0\.(\d+)"/.exec(xml)![1];
  const versioned = await cdn.request(`${root}Zwift_ver_cur.${build}.xml`);
  assert.equal(await versioned.text(), xml);
  assert.equal(await responseStatus(cdn.request(macVersion)), 200);
  assert.equal(await responseStatus(cdn.request(`${root}Launcher_ver_cur.xml`)), 200);

  for (const path of [unknown, manifest, launcher, macLauncher]) {
    assert.equal(await responseStatus(cdn.request(path)), 404);
  }
  assert.equal(upstream.mock.callCount(), 0);
  const asset = await cdn.request('/gameassets/asset-proxy-test.xml');
  assert.equal(await asset.text(), 'from Zwift');

  assert.equal(await responseStatus(patch(true, regular)), 403);
  assert.equal(await responseStatus(patch(true, admin, 'incorrect')), 403);
  assert.equal(await responseStatus(patch(true)), 200);
  assert.deepEqual(await state(createWebApp(f)), { allowed: true, available: true });
  const enabledCdn = createCdn(f);
  const officialVersion = await enabledCdn.request(version);
  assert.equal(await officialVersion.text(), 'from Zwift');

  for (const path of [unknown, manifest, launcher, macLauncher]) {
    const target = `${path}?check=1`;
    const redirect = await f.app.request(`https://cdn.zwift.com${target}`);
    // eslint-disable-next-line unicorn/prefer-https -- The update request moves to the HTTP CDN listener.
    assert.equal(redirect.headers.get('Location'), `http://cdn.zwift.com${target}`);
    const result = await enabledCdn.request(target, { headers: { Range: 'bytes=0-' } });
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.equal(await result.text(), 'from Zwift');
    const [url, options] = upstream.mock.calls.at(-1)!.arguments;
    assert.equal(url, `https://cdn.zwift.com${target}`);
    assert.deepEqual(options.headers, { Range: 'bytes=0-' });
  }

  const disabled = { ...f, config: { ...f.config, proxy: { mode: 'disabled' as const } } };
  assert.deepEqual(await state(createWebApp(disabled)), { allowed: true, available: false });
  assert.equal(await responseStatus(createCdn(disabled).request(manifest)), 404);
  assert.equal(await responseStatus(patch(false)), 200);
  assert.equal(await responseStatus(enabledCdn.request(manifest)), 404);
  assert.deepEqual(await state(), { allowed: false, available: true });
});
