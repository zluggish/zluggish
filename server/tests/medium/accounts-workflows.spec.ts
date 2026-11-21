import { ManagementService } from '#src/services/management.service';
import { responseStatus, inputValue } from '#tests/support/html';
import { createGameApp } from '#src/http/app';
import { migrateAccounts } from '#src/migrations/accounts';
import { LoginRequestSchema, LoginResponseSchema } from '#src/protocol/generated/login_pb';
import { TcpConfigSchema } from '#src/protocol/generated/per-session-info_pb';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { AccountsService } from '#src/services/auth.service';
import { ImportsService } from '#src/services/profile-import.service';
import { worldTime } from '#src/world/state';
import { mediumBrowser, mediumFixture } from '#tests/medium/support';
import { pythonFixtures } from '#tests/support/python';
import { runtimeFixture } from '#tests/support/runtime';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Schema } from 'effect';

function browser(app: ReturnType<typeof createGameApp>) {
  // A small cookie jar: the session cookie and per-rider remember cookies live side by side.
  const jar = new Map<string, string>();
  let csrf = '';

  const client = {
    jar,
    async request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set('Cookie', Array.from(jar, ([name, value]) => `${name}=${value}`).join('; '));
      const response = await app.request(path, { ...init, headers });

      for (const set of response.headers.getSetCookie()) {
        const pair = set.split(';', 1)[0] ?? '';
        const name = pair.slice(0, pair.indexOf('='));
        const value = pair.slice(pair.indexOf('=') + 1);

        if (value && !/max-age=0/i.test(set)) {
          jar.set(name, value);
        } else {
          jar.delete(name);
        }
      }

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
      csrf = inputValue(text, 'csrf_token') ?? '';

      return text;
    },
  };

  return client;
}

await test('empty game app directs the operator to web setup and cannot register riders', async (t) => {
  const f = runtimeFixture(t);
  const client = browser(f.app);
  const picker = await client.request('/login/');
  assert.equal(picker.status, 200);
  assert.match(await picker.text(), /No users are available\. Ask the administrator to create a user in the web app\./);

  const registration = [
    '/riders/add/',
    '/signup/',
    '/launcher/realms/zwift/protocol/openid-connect/registrations',
    '/auth/realms/zwift/protocol/openid-connect/registrations',
    '/auth/realms/zwift/tokens/registrations',
  ];

  for (const path of registration) {
    for (const method of ['GET', 'POST']) {
      const response = await client.request(path, { method });
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.match(await response.text(), /Registration is not available/);
    }
  }

  assert.equal(await responseStatus(client.request('/api/users', { method: 'POST' })), 403);
  const service = f.effects.runSync(ManagementService);
  await f.effects.runPromise(
    service.setup({
      mode: 'new',
      key: f.effects.runSync(service.issueSetupKey())!,
      username: 'alex',
      first_name: 'Alex',
      last_name: 'Rider',
      password: 'owner-password',
    }),
  );
  await client.picker();
  const login = await client.form('/login/', { player_id: '1', step: 'password', password: 'owner-password' });
  assert.equal(login.status, 302);
  assert.equal(await responseStatus(client.request('/api/profiles/me')), 200);
});

await test('choosing a rider asks for the password unless this computer remembers it', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Alex Rider', 'first');
  const remembered = `zluggish_remember_${rider.player_id}`;
  const warn = t.mock.method(f.world.lifecycle.log, 'warn', () => {});
  const client = browser(f.app);
  const picker = await client.picker();
  assert.equal(inputValue(picker, 'password'), undefined);

  const step = await client.form('/login/', { player_id: String(rider.player_id) });
  const unlock = await step.text();
  assert.equal(step.status, 200);
  assert.match(unlock, /<title>Alex Rider<\/title>/);
  assert.equal(inputValue(unlock, 'step'), 'password');
  assert.match(unlock, /name="password"/);
  assert.match(unlock, /name="remember"/);

  const wrong = await client.form('/login/', {
    player_id: String(rider.player_id),
    password: 'nope',
    step: 'password',
    remember: 'on',
  });

  assert.equal(wrong.status, 200);
  assert.match(await wrong.text(), /Wrong password\. Try again\./);
  assert.equal(client.jar.has(remembered), false);

  // Every failed attempt is a WARN naming the rider, even back to back.
  await client.form('/login/', { player_id: String(rider.player_id), password: 'again', step: 'password' });
  assert.deepEqual(
    warn.mock.calls.map((call) => [call.arguments[0], call.arguments[1]]),
    Array.from({ length: 2 }, () => ['auth.login_failed', 'Login failed: wrong password for rider 1 (Alex Rider)']),
  );
  const profile = await client.request('/api/profiles/me');
  assert.equal(profile.status, 401);

  const forgotten = await client.form('/login/', {
    player_id: String(rider.player_id),
    password: 'first',
    step: 'password',
  });

  assert.equal(forgotten.status, 302);
  assert.equal(client.jar.has(remembered), false);

  await client.picker();

  const right = await client.form('/login/', {
    player_id: String(rider.player_id),
    password: 'first',
    step: 'password',
    remember: 'on',
  });

  assert.equal(right.status, 302);
  assert.ok(client.jar.get(remembered));
  assert.ok(!client.jar.get(remembered)?.includes('first'));

  await client.picker();
  const again = await client.form('/login/', { player_id: String(rider.player_id) });
  assert.equal(again.status, 302);

  // A remembered token only signs in its own rider, and only until it expires.
  const token = client.jar.get(remembered) ?? '';
  const other = await f.accounts.create('Other Rider', 'second');
  assert.equal(f.sessions.remembered(token, other.player_id), null);
  assert.equal(f.sessions.remembered(token, rider.player_id, Date.now() + 91 * 86_400_000), null);
  assert.equal(f.sessions.remembered(`${f.accounts.identityOf(rider)}|forged`, rider.player_id), null);

  // A password change revokes every remembered login for the rider.
  await f.accounts.changePassword(rider.player_id, 'changed');
  await client.picker();
  const revoked = await client.form('/login/', { player_id: String(rider.player_id) });
  assert.equal(revoked.status, 200);
  assert.match(await revoked.text(), /name="password"/);
});

await test('choosing a rider without a password fails on the rider list', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Legacy Rider', 'test-password');
  f.accounts.db.prepare('UPDATE user SET pass_hash=NULL WHERE player_id=?').run(rider.player_id);
  const warn = t.mock.method(f.world.lifecycle.log, 'warn', () => {});
  const client = browser(f.app);
  await client.picker();

  // The rider only learns that login failed; the administrator gets the recovery steps in the log.
  const chosen = await client.form('/login/', { player_id: String(rider.player_id) });
  const html = await chosen.text();
  assert.match(html, /<title>Who’s riding\?<\/title>/);
  assert.match(html, /Login failed\./);
  assert.doesNotMatch(html, /accounts recover|name="password"/);
  assert.equal(warn.mock.calls[0]?.arguments[0], 'auth.login_no_password');
  assert.match(String(warn.mock.calls[0]?.arguments[1]), /accounts recover --user 1 --password-file/);

  const guessed = await client.form('/login/', { player_id: String(rider.player_id), step: 'password', password: 'x' });
  assert.match(await guessed.text(), /Login failed\./);
  const profile = await client.request('/api/profiles/me');
  assert.equal(profile.status, 401);
});

await test('distinct riders launch and refresh independently; password change revokes existing tokens', async (t) => {
  const f = runtimeFixture(t);
  const a = await f.accounts.create('Alex Rider', 'first');
  const b = await f.accounts.create('Alex Rider', 'test-password');
  const one = browser(f.app);
  const two = browser(f.app);

  for (const [client, user, password] of [
    [one, a, 'first'],
    [two, b, 'test-password'],
  ] satisfies Array<[ReturnType<typeof browser>, typeof a, string]>) {
    await client.picker();

    const response5 = await client.form('/login/', {
      player_id: String(user.player_id),
      password,
      step: 'password',
    });

    assert.equal(response5.status, 302);
    const launch = await client.request('/ride');

    const code = new URL(launch.headers.get('Location') ?? '').searchParams.get('code') ?? '';

    const exchange = await client.request('/auth/realms/zwift/protocol/openid-connect/token', {
      method: 'POST',
      body: new URLSearchParams({ code }),
    });

    const tokens = Schema.decodeUnknownSync(
      Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String }),
    )(await exchange.json());

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

  const user = await f.accounts.create('<script>evil</script>', 'test-password', 'local@example.test');

  assert.equal(user.player_id, 8);
  await assert.rejects(f.accounts.create('Duplicate', 'test-password', user.username));
  assert.equal(existsSync(resolve(f.accounts.storage, '9')), false);
  const html = await browser(f.app).picker();
  assert.match(html, /&lt;script(?:&gt;|>)/);
  assert.ok(!html.includes('<script>evil'));
});

await test('active riders cannot launch twice or replace their profile', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Active', 'test-password');
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
  await client.form('/login/', { player_id: String(user.player_id), step: 'password', password: 'test-password' });
  const response7 = await client.request('/ride');
  assert.equal(response7.status, 409);
  const imports = f.effects.runSync(ImportsService);
  assert.throws(
    () =>
      f.effects.runSync(
        imports.prepare(user, {
          'profile.bin': toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 99n, firstName: 'Remote' })),
        }),
      ),
    /active ride/,
  );
});

await test('profile imports stage, preserve unknown fields, normalize IDs and keep passwords', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Local Rider', 'secret');
  const imports = f.effects.runSync(ImportsService);

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

  const stage = f.effects.runSync(imports.prepare(user, { 'profile.bin': bytes }));
  assert.equal(f.profiles.get(user.player_id).firstName, 'Local');
  f.effects.runSync(imports.publish(user, stage, false));
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

  const user = await f.accounts.create('Native', 'secret', 'native@example.test');

  const tokenResponse = await f.app.request('/auth/realms/zwift/protocol/openid-connect/token', {
    method: 'POST',
    body: new URLSearchParams({
      username: user.username,
      password: 'secret',
    }),
  });

  const token = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }))(
    await tokenResponse.json(),
  ).access_token;

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
  const rider = await f.accounts.create('Existing Rider', 'test-password');
  f.accounts.close();
  const current = resolve(f.accounts.storage, 'zluggish.db');
  const legacy = resolve(f.accounts.storage, 'zwift-offline.db');
  assert.ok(existsSync(current));
  renameSync(current, legacy);
  const reopened = AccountsService.open(f.accounts.storage);
  t.after(() => reopened.close());
  assert.equal(reopened.get(rider.player_id)?.first_name, 'Existing');
  assert.ok(existsSync(current));
  assert.ok(!existsSync(legacy));
  reopened.close();
});

await test('account migration publishes the renamed database and preserves riders', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Migrated Rider', 'test-password');
  const oldScrypt = await f.accounts.create('Scrypt Rider', 'test-password');
  const currentRider = await f.accounts.create('Current Rider', 'current-password');
  const currentHash = currentRider.pass_hash;
  const passwordless = await f.accounts.create('Passwordless Rider', 'test-password');
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
  assert.throws(() => AccountsService.open(f.accounts.storage), /upgrade required/);
  migrateAccounts(f.accounts.storage);
  migrateAccounts(f.accounts.storage);

  assert.ok(existsSync(current));
  assert.ok(!existsSync(legacy));
  const reopened = AccountsService.open(f.accounts.storage);
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
  const user = await f.accounts.create('Port Rider', 'test-password');

  for (const port of [f.config.network.tcp.port, 4025]) {
    const app = createGameApp(
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

    if (path !== '/missing') {
      assert.equal(response.headers.has('Set-Cookie'), false);
    }
  }

  assert.equal(f.sessions.browsers.size, 1);
});

await test('session capacity preserves pending sign-ins and authenticated browsers', async (t) => {
  const f = await mediumFixture(t);
  const signedIn = await mediumBrowser(f);
  const pending = browser(f.app);
  await pending.picker();
  const anonymous = f.sessions.open();

  while (f.sessions.browsers.size < 10_000) {
    f.sessions.open();
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await f.app.request('/login/');
    assert.equal(response.status, 503);
    assert.equal(response.headers.has('Set-Cookie'), false);
  }
  assert.equal(f.sessions.browsers.size, 10_000);
  assert.equal(f.sessions.open(anonymous.id).session, anonymous.session);
  assert.equal(f.sessions.validCsrf(anonymous.session, anonymous.session.csrf), true);
  const dashboard = await signedIn.request(`/user/${f.rider.username}/`);
  assert.equal(dashboard.status, 200);

  const login = await pending.form('/login/', {
    player_id: String(f.rider.player_id),
    step: 'password',
    password: 'test-password',
  });
  assert.equal(login.status, 302);

  f.sessions.end(anonymous.id);
  assert.notEqual(f.sessions.open(anonymous.id).session, anonymous.session);
  assert.equal(f.sessions.browsers.size, 10_000);
});

await test('session expiry is bounded, refreshes last use and checks requested sessions directly', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const f = await mediumFixture(t);
  f.sessions.browsers.clear();
  const oldest = f.sessions.open();
  const refreshed = f.sessions.open();

  for (let index = 0; index < 200; index++) {
    f.sessions.open();
  }
  const last = f.sessions.open();
  f.sessions.transition(last.session, { type: 'login', identity: f.accounts.identityOf(f.rider) });
  t.mock.timers.setTime(2000);
  assert.equal(f.sessions.open(refreshed.id).session, refreshed.session);
  t.mock.timers.setTime(1000 + 86_400_000);
  assert.equal(f.sessions.open(oldest.id).session, oldest.session);
  t.mock.timers.setTime(1001 + 86_400_000);
  const before = f.sessions.browsers.size;
  const replacement = f.sessions.open(last.id);
  assert.notEqual(replacement.session, last.session);
  // 64 expired entries reclaimed, plus the expired requested entry, then one admitted.
  assert.equal(f.sessions.browsers.size, before - 64);
  assert.equal(f.sessions.browsers.get(refreshed.id), refreshed.session);
  assert.equal(f.sessions.browsers.get(oldest.id), oldest.session);

  while (f.sessions.browsers.size > 3) {
    f.sessions.open(refreshed.id);
  }
  assert.equal(f.sessions.browsers.has(last.id), false);
  assert.equal(f.sessions.open(refreshed.id).session, refreshed.session);
});
