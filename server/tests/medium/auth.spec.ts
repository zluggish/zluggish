import { mediumBrowser, mediumFixture } from '#tests/medium/support';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';

const tokenPath = '/auth/realms/zwift/protocol/openid-connect/token';
const tokenSchema = z.object({ access_token: z.string(), refresh_token: z.string() });

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
  const tokens = tokenSchema.parse(await response.json());

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

  const payload = z
    .object({ session_cookie: z.string() })
    .passthrough()
    .parse(JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString()));

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

  const rejected = await one.form(`/reset/${f.rider.username}/`, {
    csrf_token: 'wrong',
    password: 'secret',
    confirm_password: 'secret',
  });

  assert.equal(rejected.status, 400);
  assert.equal(f.accounts.get(f.rider.player_id)?.auth_version, f.rider.auth_version);

  const response = await one.form(`/reset/${f.rider.username}/`, { password: 'secret', confirm_password: 'secret' });
  assert.equal(response.status, 302);

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

await test('failed account creation rolls back rows and folders and leaves the service usable', async (t) => {
  const f = await mediumFixture(t);
  const before = f.accounts.list();
  const nextId = Math.max(...before.map((rider) => rider.player_id)) + 1;

  for (const name of ['', ' '.repeat(3), 'x'.repeat(101)])
    await assert.rejects(f.accounts.create(name, ''), /Enter a name/);
  await assert.rejects(f.accounts.create('Second owner', '', true), /Setup already completed/);
  await assert.rejects(f.accounts.create('Duplicate', '', false, f.rider.username));
  assert.deepEqual(f.accounts.list(), before);
  assert.equal(f.accounts.db.isTransaction, false);
  assert.equal(existsSync(resolve(f.accounts.storage, String(nextId))), false);
  assert.equal(f.accounts.setupComplete(), true);

  const created = await f.accounts.create('  New   Rider  ', '');
  assert.equal(created.player_id, nextId);
  assert.equal(created.first_name, 'New');
  assert.equal(created.last_name, 'Rider');
  assert.equal(created.is_admin, 0);
  assert.equal(existsSync(resolve(f.accounts.storage, String(nextId))), true);
});
