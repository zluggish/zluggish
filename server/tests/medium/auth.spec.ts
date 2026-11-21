import { ManagementService } from '#src/services/management.service';
import { decodeOwned } from '#src/schema';
import { Schema } from 'effect';
import { mediumBrowser, mediumFixture, mediumWeb } from '#tests/medium/support';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const tokenPath = '/auth/realms/zwift/protocol/openid-connect/token';
const tokenSchema = Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String });

await test('credential login rejects wrong, missing and unknown credentials without issuing tokens', async (t) => {
  const f = await mediumFixture(t);
  await f.accounts.changePassword(f.rider.player_id, 'secret');

  for (const fields of [
    { username: f.rider.username, password: 'wrong' },
    { username: f.rider.username, password: '' },
    { username: 'missing@example.test', password: 'secret' },
    { username: f.other.username, password: '' },
  ]) {
    const response = await f.app.request(tokenPath, { method: 'POST', body: new URLSearchParams(fields) });
    assert.equal(response.status, 401);
    const body = await response.text();
    assert.equal(body.includes('access_token'), false);
  }

  const response = await f.app.request(tokenPath, {
    method: 'POST',
    body: new URLSearchParams({ username: f.rider.username, password: 'secret' }),
  });

  assert.equal(response.status, 200);
  const tokens = Schema.decodeUnknownSync(tokenSchema)(await response.json());

  const profile = await f.app.request('/api/profiles/me', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  assert.equal(profile.status, 200);
  assert.equal(f.sessions.bearer(tokens.access_token)?.player_id, f.rider.player_id);
});

await test('malformed and forged session identities are rejected by API and token exchange', async (t) => {
  const f = await mediumFixture(t);
  const valid = f.sessions.tokens(f.rider, f.tokens).refresh_token;
  const parts = valid.split('.');

  const payload = decodeOwned(
    Schema.StructWithRest(Schema.Struct({ session_cookie: Schema.String }), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  )(JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString()));

  payload.session_cookie = `${f.other.player_id}:${f.other.auth_version}|forged`;
  const forged = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${parts[2]}`;

  for (const token of ['garbage', 'header.e30.signature', 'header.bm90LWpzb24.signature', forged]) {
    const profile = await f.app.request('/api/profiles/me', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(profile.status, 401);

    for (const fields of [{ refresh_token: token }, { code: `zwift_refresh_token${token}` }]) {
      const response = await f.app.request(tokenPath, { method: 'POST', body: new URLSearchParams(fields) });
      assert.equal(response.status, 401);
    }
  }

  const response = await f.app.request(tokenPath, { method: 'POST', body: new URLSearchParams({ code: valid }) });
  assert.equal(response.status, 401);
});

await test('password reset validates current password and confirmation before changing credentials', async (t) => {
  const f = await mediumFixture(t);
  await f.accounts.changePassword(f.rider.player_id, 'original');
  const rider = f.accounts.get(f.rider.player_id);
  assert.ok(rider);
  const headers = f.headers(rider);

  for (const [current, confirmation, status] of [
    ['wrong', 'new', 403],
    ['original', 'different', 400],
  ] as const) {
    const response = await f.app.request('/api/users/password-reset/', {
      method: 'POST',
      headers,
      body: new URLSearchParams({ current_password: current, 'password-new': 'new', 'password-confirm': confirmation }),
    });

    assert.equal(response.status, status);
    assert.deepEqual(f.accounts.get(rider.player_id), rider);
    const profile = await f.app.request('/api/profiles/me', { headers });
    assert.equal(profile.status, 200);
  }

  const response = await f.app.request('/api/users/password-reset/', {
    method: 'POST',
    headers,
    body: new URLSearchParams({ current_password: 'original', 'password-new': 'new', 'password-confirm': 'new' }),
  });

  assert.equal(response.status, 204);
  const updated = f.accounts.get(rider.player_id);
  assert.ok(updated);
  assert.equal(updated.auth_version, rider.auth_version + 1);
  assert.equal(await f.accounts.verify(updated, 'original'), false);
  assert.equal(await f.accounts.verify(updated, 'new'), true);
  const profile = await f.app.request('/api/profiles/me', { headers });
  assert.equal(profile.status, 401);
});

await test('setting a password revokes all of that rider’s sessions and refresh tokens only', async (t) => {
  const f = await mediumFixture(t);
  const one = await mediumBrowser(f);
  const two = await mediumBrowser(f);
  const other = await mediumBrowser(f, f.other);
  const tokens = f.sessions.tokens(f.rider, f.tokens);

  const web = mediumWeb(f, f.rider);
  const rejected = await web.request('/api/me/password', 'POST', { current_password: 'wrong', password: 'secret' });
  assert.equal(rejected.status, 403);
  assert.equal(f.accounts.get(f.rider.player_id)?.auth_version, f.rider.auth_version);

  const response = await web.request('/api/me/password', 'POST', {
    current_password: 'test-password',
    password: 'secret',
  });

  assert.equal(response.status, 200);

  for (const browser of [one, two]) {
    const profile = await browser.request('/api/profiles/me');
    assert.equal(profile.status, 401);
  }

  const otherBrowser = await other.request('/api/profiles/me');
  const otherToken = await f.request('/api/profiles/me', {}, f.other);

  const revoked = await f.app.request('/api/profiles/me', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  assert.equal(otherBrowser.status, 200);
  assert.equal(otherToken.status, 200);
  assert.equal(revoked.status, 401);

  const refresh = await f.app.request(tokenPath, {
    method: 'POST',
    body: new URLSearchParams({ refresh_token: tokens.refresh_token }),
  });

  assert.equal(refresh.status, 401);
});

await test('an administrator changes their own password without the current one', async (t) => {
  const f = await mediumFixture(t);
  const management = f.effects.runSync(ManagementService);

  await f.effects.runPromise(
    management.setup({
      mode: 'existing',
      key: f.effects.runSync(management.issueSetupKey())!,
      username: f.rider.username,
      password: 'test-password',
    }),
  );

  const administrator = f.accounts.get(f.rider.player_id)!;
  const response = await mediumWeb(f, administrator).request('/api/me/password', 'POST', { password: 'secret' });
  assert.equal(response.status, 200);
  assert.equal(await f.accounts.verify(f.accounts.get(administrator.player_id)!, 'secret'), true);

  const rider = await mediumWeb(f, f.other).request('/api/me/password', 'POST', { password: 'secret' });
  assert.equal(rider.status, 403);
});

await test('failed account creation rolls back rows and folders and leaves the service usable', async (t) => {
  const f = await mediumFixture(t);
  const before = f.accounts.list();
  const nextId = Math.max(...before.map((rider) => rider.player_id)) + 1;

  for (const name of ['', ' '.repeat(3), 'x'.repeat(101)]) {
    await assert.rejects(f.accounts.create(name, 'test-password'), /Enter a name/);
  }
  await assert.rejects(f.accounts.create('Duplicate', 'test-password', f.rider.username));
  assert.deepEqual(f.accounts.list(), before);
  assert.equal(f.accounts.db.isTransaction, false);
  assert.equal(existsSync(resolve(f.accounts.storage, String(nextId))), false);

  const created = await f.accounts.create('  New   Rider  ', 'test-password');
  assert.equal(created.player_id, nextId);
  assert.equal(created.first_name, 'New');
  assert.equal(created.last_name, 'Rider');
  assert.equal(created.role, 'rider');
  assert.equal(existsSync(resolve(f.accounts.storage, String(nextId))), true);
});

await test('game password routes share throttling while refresh and remembered login still work', async (t) => {
  const f = await mediumFixture(t);
  const browser = await mediumBrowser(f);
  const tokens = f.sessions.tokens(f.rider, f.tokens);
  const verify = t.mock.method(f.accounts, 'verify', () => Promise.resolve(false));

  for (let i = 0; i < 9; i++) {
    const response = await f.app.request(tokenPath, {
      method: 'POST',
      body: new URLSearchParams({ username: f.rider.username.toUpperCase(), password: 'wrong' }),
    });
    assert.equal(response.status, 401);
  }
  const blocked = await browser.form('/login/', {
    player_id: String(f.rider.player_id),
    step: 'password',
    password: 'test-password',
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('Retry-After'), '60');
  assert.equal(verify.mock.callCount(), 9);
  const blockedToken = await f.app.request(tokenPath, {
    method: 'POST',
    body: new URLSearchParams({ username: f.rider.username, password: 'test-password' }),
  });
  assert.equal(blockedToken.status, 429);
  assert.equal(blockedToken.headers.get('Retry-After'), '60');
  const refresh = await f.app.request(tokenPath, {
    method: 'POST',
    body: new URLSearchParams({ refresh_token: tokens.refresh_token }),
  });
  assert.equal(refresh.status, 200);
  const opened = f.sessions.open();
  const remembered = await f.app.request('/login/', {
    method: 'POST',
    headers: {
      Cookie: `zluggish_session=${opened.id}; zluggish_remember_${f.rider.player_id}=${f.sessions.remember(f.rider)}`,
    },
    body: new URLSearchParams({ csrf_token: opened.session.csrf, player_id: String(f.rider.player_id) }),
  });
  assert.equal(remembered.status, 302);
  assert.equal(verify.mock.callCount(), 9);
});

await test('overlapping password requests reject before hashing and release slots after errors', async (t) => {
  const f = await mediumFixture(t);
  const pending = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const verify = t.mock.method(f.accounts, 'verify', async () => {
    started.resolve();
    await pending.promise;
    throw new Error('hash failure');
  });
  const request = () =>
    f.app.request(tokenPath, {
      method: 'POST',
      body: new URLSearchParams({ username: f.rider.username, password: 'wrong' }),
    });
  const first = request();
  await started.promise;
  const blocked = await request();
  assert.equal(blocked.status, 429);
  assert.equal(verify.mock.callCount(), 1);
  pending.resolve();
  const failed = await first;
  assert.equal(failed.status, 500);
  verify.mock.mockImplementation(() => Promise.resolve(false));
  const retried = await request();
  assert.equal(retried.status, 401);
});

await test('unknown usernames and forged forwarding headers cannot bypass peer limits', async (t) => {
  const f = await mediumFixture(t);
  const verify = t.mock.method(f.accounts, 'verify', () => Promise.resolve(true));
  for (let i = 0; i < 31; i++) {
    const response = await f.app.request(tokenPath, {
      method: 'POST',
      headers: { 'X-Forwarded-For': `192.0.2.${i}`, 'X-Real-IP': `192.0.2.${i}` },
      body: new URLSearchParams({ username: `unknown-${i}`, password: 'wrong' }),
    });
    assert.equal(response.status, i < 30 ? 401 : 429);
  }
  assert.equal(verify.mock.callCount(), 0);
});
