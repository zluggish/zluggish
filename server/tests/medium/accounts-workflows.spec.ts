import { mediumFixture, mediumBrowser } from '#tests/medium/support';
import { migrateAccounts } from '#src/repositories/account-migration.repository';
import { Accounts } from '#src/repositories/accounts.repository';
import { ProfileImports } from '#src/repositories/profile-import.repository';
import { createApp } from '#src/http/app';
import { LoginRequestSchema, LoginResponseSchema } from '#src/protocol/generated/login_pb';
import { TcpConfigSchema } from '#src/protocol/generated/per-session-info_pb';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { worldTime } from '#src/world/state';
import { runtimeFixture } from '#tests/support/runtime';
import { pythonFixtures } from '#tests/support/python';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';

function browser(app: ReturnType<typeof createApp>) {
  let cookie = '';
  let csrf = '';

  const client = {
    async request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set('Cookie', cookie);
      const response = await app.request(path, { ...init, headers });
      const set = response.headers.getSetCookie().at(-1);

      if (set) cookie = set.split(';', 1)[0] ?? '';

      return response;
    },
    async form(path: string, fields: Record<string, string>) {
      return client.request(path, {
        method: 'POST',
        body: new URLSearchParams({ ...fields, csrf_token: csrf }),
      });
    },
    async picker() {
      const response = await client.request('/login/');
      const text = await response.text();
      csrf = /name="csrf_token"\s+value="([^"]+)"/.exec(text)?.[1] ?? '';

      return text;
    },
  };

  return client;
}

await test('first-owner setup and passwordless rider selection are real HTTP flows', async (t) => {
  const f = runtimeFixture(t);
  const client = browser(f.app);

  for (const path of ['/launcher', '/launcher/ride', '/ride']) {
    const launch = await client.request(path);
    assert.equal(launch.status, 302);
    assert.equal(launch.headers.get('Location'), '/login/');
  }

  const redirect = await client.request('/login/');
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('Location'), '/riders/add/');
  const setup = await client.request(redirect.headers.get('Location')!);
  const html = await setup.text();
  assert.match(html, /<link rel="stylesheet" href="\/style\/site.css"/);
  const csrf = /name="csrf_token"\s+value="([^"]+)"/.exec(html)?.[1] ?? '';

  assert.match(html, /<title>Add rider<\/title>/);
  assert.ok(!html.includes('setup_token'));

  const rejected = await client.request('/riders/add/', {
    method: 'POST',
    body: new URLSearchParams({ display_name: 'Missing CSRF' }),
  });

  assert.equal(rejected.status, 400);

  const response = await client.request('/riders/add/', {
    method: 'POST',
    body: new URLSearchParams({ csrf_token: csrf, display_name: 'Alex Rider' }),
  });

  assert.equal(response.status, 302);
  assert.equal(f.accounts.get(1)?.first_name, 'Alex');
  assert.equal(f.accounts.get(1)?.last_name, 'Rider');
  assert.equal(f.accounts.get(1)?.is_admin, 1);
  assert.equal(existsSync(resolve(f.accounts.storage, 'setup-token.txt')), false);
  await client.picker();
  const response3 = await client.form('/login/', { player_id: '1' });
  assert.equal(response3.status, 302);
  const response4 = await client.request('/api/profiles/me');
  assert.equal(response4.status, 200);
});

await test('distinct riders launch and refresh independently; password change revokes existing tokens', async (t) => {
  const f = runtimeFixture(t);
  const a = await f.accounts.create('Alex Rider', 'first', true);
  const b = await f.accounts.create('Alex Rider', '', false);
  const one = browser(f.app);
  const two = browser(f.app);

  for (const [client, user, password] of [
    [one, a, 'first'],
    [two, b, ''],
  ] satisfies [ReturnType<typeof browser>, typeof a, string][]) {
    await client.picker();

    const response5 = await client.form('/login/', {
      player_id: String(user.player_id),
      password,
    });

    assert.equal(response5.status, 302);
    const launch = await client.request('/ride');

    const code = new URL(launch.headers.get('Location') ?? '').searchParams.get('code') ?? '';

    const exchange = await client.request('/auth/realms/zwift/protocol/openid-connect/token', {
      method: 'POST',
      body: new URLSearchParams({ code }),
    });

    const tokens = z.object({ access_token: z.string(), refresh_token: z.string() }).parse(await exchange.json());

    assert.equal(f.sessions.bearer(tokens.access_token)?.player_id, user.player_id);

    const response6 = await client.request('/auth/realms/zwift/protocol/openid-connect/token', {
      method: 'POST',
      body: new URLSearchParams({ refresh_token: tokens.refresh_token }),
    });

    assert.equal(response6.status, 200);

    if (user.player_id !== a.player_id) {
      continue;
    }

    await f.accounts.changePassword(a.player_id, 'changed');
    assert.equal(f.sessions.bearer(tokens.access_token), null);
  }
});

await test('folder collisions, failed duplicate username and unsafe names preserve data', async (t) => {
  const f = runtimeFixture(t);
  mkdirSync(resolve(f.accounts.storage, '7'));

  const user = await f.accounts.create('<script>evil</script>', '', true, 'local@example.test');

  assert.equal(user.player_id, 8);
  await assert.rejects(f.accounts.create('Duplicate', '', false, user.username));
  assert.equal(existsSync(resolve(f.accounts.storage, '9')), false);
  const html = await browser(f.app).picker();
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>evil'));
});

await test('active riders cannot launch twice or replace their profile', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Active', '', true);
  f.world.receive(
    BigInt(user.player_id),
    create(PlayerStateSchema, {
      id: BigInt(user.player_id),
      roadTime: 1,
      worldTime: worldTime(),
    }),
  );
  const client = browser(f.app);
  await client.picker();
  await client.form('/login/', { player_id: String(user.player_id) });
  const response7 = await client.request('/ride');
  assert.equal(response7.status, 409);
  const imports = new ProfileImports(f.accounts, f.world);
  assert.throws(
    () =>
      imports.prepare(user, {
        'profile.bin': toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 99n, firstName: 'Remote' })),
      }),
    /active ride/,
  );
});

await test('profile imports stage, preserve unknown fields, normalize IDs and keep passwords', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Local Rider', 'secret', true);
  const imports = new ProfileImports(f.accounts, f.world);

  const bytes = Buffer.concat([
    toBinary(
      PlayerProfileSchema,
      create(PlayerProfileSchema, {
        id: 999n,
        firstName: 'Remote',
        totalXp: 1200,
      }),
    ),
    Buffer.from('a01f07', 'hex'),
  ]);

  const stage = imports.prepare(user, { 'profile.bin': bytes });
  assert.equal(f.profiles.get(user.player_id).firstName, 'Local');
  imports.publish(user, stage, false);
  const saved = f.profiles.get(user.player_id);
  assert.equal(saved.id, BigInt(user.player_id));
  assert.equal(saved.firstName, 'Remote');
  assert.equal(saved.totalXp, 1200);
  assert.ok(saved.$unknown?.length);
  assert.equal(f.accounts.get(user.player_id)?.official_player_id, '999');
  assert.equal(await f.accounts.verify(user, 'secret'), true);
});

await test('native login and HTTP login share one relay owner with protobuf economy', async (t) => {
  const f = runtimeFixture(t);

  const user = await f.accounts.create('Native', 'secret', true, 'native@example.test');

  const tokenResponse = await f.app.request('/auth/realms/zwift/protocol/openid-connect/token', {
    method: 'POST',
    body: new URLSearchParams({
      username: user.username,
      password: 'secret',
    }),
  });

  const token = z.object({ access_token: z.string() }).parse(await tokenResponse.json()).access_token;

  const key = new Uint8Array(16).fill(7);

  const login = await f.app.request('/api/users/login', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: toBinary(LoginRequestSchema, create(LoginRequestSchema, { key })),
  });

  assert.equal(login.status, 200);

  const decoded = fromBinary(LoginResponseSchema, new Uint8Array(await login.arrayBuffer()));

  assert.equal(decoded.relaySessionId, user.player_id);
  assert.deepEqual(f.world.relays.get(BigInt(user.player_id))?.key, Buffer.from(key));
  assert.ok(decoded.economyConfig?.cyclingLevels.length);
});

await test('existing Zluggish database is renamed without losing riders', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Existing Rider', '', true);
  f.accounts.close();
  const current = resolve(f.accounts.storage, 'zluggish.db');
  const legacy = resolve(f.accounts.storage, 'zwift-offline.db');
  assert.ok(existsSync(current));
  renameSync(current, legacy);
  const reopened = new Accounts(f.accounts.storage);
  t.after(() => reopened.close());
  assert.equal(reopened.get(rider.player_id)?.first_name, 'Existing');
  assert.ok(existsSync(current));
  assert.ok(!existsSync(legacy));
  reopened.close();
});

await test('account migration publishes the renamed database and preserves riders', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Migrated Rider', '', true);
  const oldScrypt = await f.accounts.create('Scrypt Rider', '');
  const currentRider = await f.accounts.create('Current Rider', 'current-password');
  const currentHash = currentRider.pass_hash;
  const passwordless = await f.accounts.create('Passwordless Rider', '');
  f.accounts.db
    .prepare('UPDATE user SET pass_hash=? WHERE player_id=?')
    .run(pythonFixtures.sha256Hash, rider.player_id);
  f.accounts.db
    .prepare('UPDATE user SET pass_hash=? WHERE player_id=?')
    .run(pythonFixtures.scryptHash, oldScrypt.player_id);
  f.accounts.close();
  const current = resolve(f.accounts.storage, 'zluggish.db');
  const legacy = resolve(f.accounts.storage, 'zwift-offline.db');
  renameSync(current, legacy);
  assert.throws(() => new Accounts(f.accounts.storage), /upgrade required/);
  // SQLite backup work needs a live event loop on newer Node releases.
  const keepAlive = setInterval(() => {}, 1000);

  try {
    await migrateAccounts(f.accounts.storage);
    await migrateAccounts(f.accounts.storage);
  } finally {
    clearInterval(keepAlive);
  }

  assert.ok(existsSync(current));
  assert.ok(!existsSync(legacy));
  const reopened = new Accounts(f.accounts.storage);
  assert.equal(reopened.get(rider.player_id)?.first_name, 'Migrated');

  for (const previous of [rider, oldScrypt]) {
    assert.equal(reopened.get(previous.player_id)?.pass_hash, null);
    assert.equal(reopened.get(previous.player_id)?.auth_version, previous.auth_version + 1);
    assert.equal(reopened.identity(`${previous.player_id}:${previous.auth_version}`), null);
  }

  assert.equal(reopened.get(passwordless.player_id)?.auth_version, passwordless.auth_version);
  assert.equal(reopened.get(currentRider.player_id)?.pass_hash, currentHash);
  assert.equal(await reopened.verify(currentRider, 'current-password'), true);
  await reopened.changePassword(rider.player_id, 'new-password');
  const updated = reopened.get(rider.player_id);
  assert.ok(updated);
  assert.equal(await reopened.verify(updated, 'new-password'), true);
  reopened.close();
});

await test('login and both TCP config endpoints advertise configured ports', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Port Rider', '', true);

  for (const port of [f.config.network.tcp.port, 4025]) {
    const app = createApp(
      { gameInfo: '{}', gameInfoHash: '0', variants: '{}' },
      {
        ...f,
        config: { ...f.config, network: { ...f.config.network, tcp: { ...f.config.network.tcp, port } } },
      },
    );

    const login = await app.request('/api/users/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}` },
      body: toBinary(LoginRequestSchema, create(LoginRequestSchema, { key: new Uint8Array(16) })),
    });

    assert.equal(login.status, 200);
    assert.equal(
      fromBinary(LoginResponseSchema, new Uint8Array(await login.arrayBuffer())).info?.nodes?.nodes[0]?.port,
      port,
    );

    for (const path of ['/api/tcp-config', '/relay/tcp-config']) {
      const response = await app.request(path);
      assert.equal(response.status, 200);
      assert.equal(fromBinary(TcpConfigSchema, new Uint8Array(await response.arrayBuffer())).nodes[0]?.port, port);
    }
  }
});

await test('anonymous API and asset traffic does not allocate sessions', async (t) => {
  const f = await mediumFixture(t);

  for (const path of ['/health', '/api/profiles/me', '/style/site.css', '/missing']) {
    const response = await f.app.request(path);

    if (path !== '/missing') assert.equal(response.headers.has('Set-Cookie'), false);
  }

  assert.equal(f.sessions.browsers.size, 1);
});

await test('session capacity evicts anonymous sessions and preserves authenticated browsers', async (t) => {
  const f = await mediumFixture(t);
  const browser = await mediumBrowser(f);
  const identity = `${f.rider.player_id}:${f.rider.auth_version}`;
  const signedIn = [...f.sessions.browsers].find(([, session]) => session.identity === identity);
  assert.ok(signedIn);
  const anonymous = f.sessions.open();

  // Populate the limit without 10,000 HTTP requests or repeated expiry scans.
  for (let index = f.sessions.browsers.size; index < 10_000; index++)
    f.sessions.browsers.set(`anonymous-${index}`, { ...anonymous.session });
  anonymous.session.touched = 0;
  // Keep the deliberately oldest entry within the session lifetime.
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });

  for (const [key, session] of f.sessions.browsers) if (key !== anonymous.id) session.touched = 1000;

  const response = await f.app.request('/login/');
  assert.equal(response.status, 200);
  assert.equal(f.sessions.browsers.size, 10_000);
  assert.equal(f.sessions.browsers.has(anonymous.id), false);
  assert.equal(f.sessions.browsers.has(signedIn[0]), true);
  const profile = await browser.request(`/profile/${f.rider.username}/`);
  assert.equal(profile.status, 200);
});
