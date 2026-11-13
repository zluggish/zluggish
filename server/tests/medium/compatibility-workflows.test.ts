import { identityOf } from '#src/domain/accounts/repository';
import { ProfileImports } from '#src/domain/profiles/imports';
import { syncWorkoutsAutomatically } from '#src/domain/workouts/automatic';
import { Workouts } from '#src/domain/workouts/planned';
import { Connections } from '#src/node/persistence/connections';
import { writeDurable } from '#src/node/persistence/files';
import { LoginRequestSchema, LoginResponseSchema } from '#src/protocol/generated/login_pb';
import { AchievementsSchema, PlayerProfileSchema, StreaksSchema } from '#src/protocol/generated/profile_pb';
import { UserStorageSchema } from '#src/protocol/generated/user_storage_pb';
import { runtimeFixture } from '#tests/support/runtime';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

await test('all rider state files stage, cancel, publish and recover with durable backups', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Import Rider', '', true);
  const imports = new ProfileImports(f.accounts, f.world);

  const files = {
    'profile.bin': toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 99n, firstName: 'Imported' })),
    'achievements.bin': toBinary(AchievementsSchema, create(AchievementsSchema)),
    'economy_config.txt': Buffer.from('{"cycling_levels":[],"f3":0,"f4":0,"f5":0}'),
    'user_storage.bin': toBinary(UserStorageSchema, create(UserStorageSchema)),
    'streaks.bin': toBinary(StreaksSchema, create(StreaksSchema, { curStreak: 3 })),
  };

  const old = toBinary(StreaksSchema, create(StreaksSchema, { curStreak: 1 }));
  writeDurable(resolve(f.profiles.folder(user.player_id), 'streaks.bin'), old);
  const canceled = imports.prepare(user, files);
  imports.cancel(user, canceled);
  assert.deepEqual(readFileSync(resolve(f.profiles.folder(user.player_id), 'streaks.bin')), Buffer.from(old));
  const stage = imports.prepare(user, files);
  assert.equal(imports.inspect(user, stage).files.length, 5);
  imports.publish(user, stage, false);
  assert.equal(f.profiles.get(user.player_id).id, BigInt(user.player_id));
  assert.equal(f.profiles.get(user.player_id).firstName, 'Imported');
  assert.equal(
    fromBinary(StreaksSchema, readFileSync(resolve(f.profiles.folder(user.player_id), 'streaks.bin'))).curStreak,
    3,
  );
  assert.ok(
    readdirSync(f.profiles.folder(user.player_id)).some(
      (name) => name.startsWith('streaks.bin.') && name.endsWith('.bak'),
    ),
  );
  const fresh = f.accounts.get(user.player_id);
  assert.ok(fresh);
  const recovering = imports.prepare(fresh, { 'streaks.bin': old });
  const folder = imports.folder(fresh, recovering);
  const manifest = imports.inspect(fresh, recovering);
  writeDurable(resolve(folder, 'old-streaks.bin'), files['streaks.bin']);
  writeDurable(resolve(folder, 'manifest.json'), JSON.stringify({ ...manifest, state: 'publishing' }), true);
  writeDurable(resolve(f.profiles.folder(user.player_id), 'streaks.bin'), old, true);
  new ProfileImports(f.accounts, f.world).recover();
  assert.equal(
    fromBinary(StreaksSchema, readFileSync(resolve(f.profiles.folder(user.player_id), 'streaks.bin'))).curStreak,
    3,
  );
  assert.throws(() => imports.prepare(fresh, { 'user_storage.bin': new Uint8Array([255]) }));
  assert.throws(() => imports.prepare(fresh, { 'economy_config.txt': Buffer.from('{"cycling_levels":"invalid"}') }));
});

await test('browser restore accepts empty protobuf state and waits for review before publishing', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Restore Rider', '', true);
  const session = f.sessions.open();
  session.session.identity = identityOf(user);
  const headers = { Cookie: `zluggish_session=${session.id}` };
  const form = new FormData();
  form.set('csrf_token', session.session.csrf);
  form.set('user_storage.bin', new File([], 'user_storage.bin'));
  form.set('streaks.bin', new File([], 'streaks.bin'));
  const response = await f.app.request(`/profile/${user.username}/`, { method: 'POST', headers, body: form });
  assert.equal(response.status, 302);
  assert.ok(session.session.pendingImport);
  assert.equal(existsSync(resolve(f.profiles.folder(user.player_id), 'streaks.bin')), false);

  const published = await f.app.request(`/profile/${user.username}/confirm/`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ csrf_token: session.session.csrf, confirm: '1', confirm_source: 'on' }),
  });

  assert.equal(published.status, 302);
  assert.equal(readFileSync(resolve(f.profiles.folder(user.player_id), 'streaks.bin')).length, 0);
  assert.equal(readFileSync(resolve(f.profiles.folder(user.player_id), 'user_storage.bin')).length, 0);
});

await test('Zwift connection encrypts secrets and official downloads stage a rider-preserving import', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Local Rider', '', true);
  const session = f.sessions.open();
  session.session.identity = identityOf(user);
  const headers = { Cookie: `zluggish_session=${session.id}` };

  const form = (fields: Record<string, string>) =>
    f.app.request(`/zwift/${user.username}/`, {
      method: 'POST',
      headers,
      body: new URLSearchParams({ ...fields, csrf_token: session.session.csrf }),
    });

  const saved = await form({
    action: 'settings',
    username: 'official@example.test',
    password: 'super-secret',
    upload: 'on',
    click: 'on',
  });

  const html = await saved.text();
  assert.doesNotMatch(html, /super-secret|official@example.test/);
  const connections = new Connections(f.config.storageDir);
  assert.deepEqual(connections.read(user.player_id, 'zwift'), ['official@example.test', 'super-secret']);
  assert.equal(readFileSync(connections.file(user.player_id, 'zwift')).includes(Buffer.from('super-secret')), false);
  assert.equal(f.settings.read(user.player_id)['uploads.zwift.enabled'], true);
  assert.equal(f.settings.read(user.player_id)['devices.zwiftClick.enabled'], true);
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);

    if (url.endsWith('/access/codes'))
      return Promise.resolve(Response.json({ access_token: 'test-token', refresh_token: 'refresh' }));

    if (url.endsWith('/tokens/logout')) return Promise.resolve(new Response(null, { status: 204 }));
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-token');

    if (url.endsWith('/api/profiles/me'))
      return Promise.resolve(
        new Response(toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 999n, firstName: 'Official' }))),
      );

    if (url.endsWith('/api/users/login'))
      return Promise.resolve(
        new Response(
          toBinary(
            LoginResponseSchema,
            create(LoginResponseSchema, {
              sessionState: 'test',
              info: { relayUrl: 'https://relay.test' },
              economyConfig: { cyclingLevels: [], f3: 0, f4: 0, f5: 0 },
            }),
          ),
        ),
      );

    if (url.endsWith('/api/achievement/loadPlayerAchievements'))
      return Promise.resolve(
        new Response(toBinary(AchievementsSchema, create(AchievementsSchema, { achievements: [{ id: 59 }] }))),
      );
    throw new Error(`Unexpected request ${url}`);
  });
  const downloaded = await form({ action: 'import', profile: 'on', achievements: 'on' });
  assert.equal(downloaded.status, 302);
  assert.equal(f.profiles.get(user.player_id).firstName, 'Local');
  assert.ok(session.session.pendingImport);

  const confirm = await f.app.request(`/profile/${user.username}/confirm/`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ csrf_token: session.session.csrf, confirm: '1' }),
  });

  assert.equal(confirm.status, 302);
  assert.equal(f.profiles.get(user.player_id).id, BigInt(user.player_id));
  assert.equal(f.profiles.get(user.player_id).firstName, 'Official');
  assert.equal(f.accounts.get(user.player_id)?.official_player_id, '999');
  assert.ok(calls.some((url) => url.endsWith('/tokens/logout')));
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(null, { status: 503 })));
  const failed = await form({ action: 'import', profile: 'on' });
  assert.match(await failed.text(), /Download failed/);
  assert.equal(f.profiles.get(user.player_id).firstName, 'Official');
  assert.equal(session.session.pendingImport, null);

  const csrf = await f.app.request(`/zwift/${user.username}/`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ action: 'settings' }),
  });

  assert.equal(csrf.status, 400);
});

const xml =
  '<workout_file><name>Tempo</name><sportType>bike</sportType><workout><SteadyState Duration="600" Power="0.8"/></workout></workout_file>';

await test('automatic home and Android login sync coalesce, preserve UUIDs and expose cycling-only schedules', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Planned Rider', '', true);
  new Connections(f.config.storageDir).save(user.player_id, 'intervals', ['123', 'key']);
  const headers = { Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}` };
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  let eventRequests = 0;
  t.mock.method(globalThis, 'fetch', (input: URL | string) => {
    if (String(input).endsWith('/download.zwo')) return Promise.resolve(new Response(xml));
    eventRequests++;

    return Promise.resolve(Response.json([{ id: 42, start_date_local: `${day}T08:00:00`, category: 'WORKOUT' }]));
  });
  const home = f.app.request(`/user/${user.username}/`, { headers });

  const login = f.app.request('/api/users/login', {
    method: 'POST',
    headers: { ...headers, 'User-Agent': 'Android' },
    body: toBinary(LoginRequestSchema, create(LoginRequestSchema, { key: new Uint8Array(16) })),
  });

  const [homeResponse, loginResponse] = await Promise.all([home, login]);
  assert.equal(homeResponse.status, 200);
  assert.match(await homeResponse.text(), /select name="climb"/);
  assert.equal(loginResponse.status, 200);
  assert.equal(eventRequests, 1);
  const workouts = new Workouts(f);
  const id = workouts.list(user.player_id)[0]?.id;
  assert.ok(id);
  f.world.logout(BigInt(user.player_id));
  await f.app.request('/api/users/login', {
    method: 'POST',
    headers: { ...headers, 'User-Agent': 'Android' },
    body: toBinary(LoginRequestSchema, create(LoginRequestSchema, { key: new Uint8Array(16) })),
  });
  assert.equal(eventRequests, 2);
  assert.equal(workouts.list(user.player_id)[0]?.id, id);

  for (const sport of ['', 'CYCLING', 'cycling', 'RUNNING', 'other']) {
    const cycling = !sport || sport.toUpperCase() === 'CYCLING';

    for (const [path, empty] of [
      ['/api/workout/schedule/list', []],
      ['/api/head-unit-bff/game-home', {}],
      ['/api/head-unit-bff/carousels/for-you', []],
    ] as const) {
      const response = await f.app.request(`${path}?sport=${sport || 'CYCLING'}`, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
      const body = await response.json();

      if (cycling) assert.notDeepEqual(body, empty);
      else assert.deepEqual(body, empty);
    }

    const detail = await f.app.request(`/api/workout/workouts/${id}?sport=${sport || 'CYCLING'}`, { headers });
    assert.equal(detail.status, cycling ? 200 : 404);
  }

  const before = readFileSync(workouts.metadataFile(user.player_id));
  t.mock.method(
    globalThis,
    'fetch',
    (_input: URL | string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        assert.ok(init?.signal);
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  );
  const controller = new AbortController();
  const aborted = workouts.sync(user.player_id, controller.signal);
  controller.abort();
  await assert.rejects(aborted);
  assert.deepEqual(readFileSync(workouts.metadataFile(user.player_id)), before);
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(null, { status: 503 })));
  f.world.logout(BigInt(user.player_id));

  const failure = await f.app.request('/api/users/login', {
    method: 'POST',
    headers: { ...headers, 'User-Agent': 'Android' },
    body: toBinary(LoginRequestSchema, create(LoginRequestSchema, { key: new Uint8Array(16) })),
  });

  assert.equal(failure.status, 200);
  assert.deepEqual(readFileSync(workouts.metadataFile(user.player_id)), before);
});

await test('automatic TrainingPeaks home refresh imports exported workouts without contacting a provider', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Bridge Rider', '', true);
  const folder = resolve(f.config.storageDir, 'bridge');
  mkdirSync(folder);
  writeDurable(resolve(folder, 'tempo.zwo'), xml);
  f.settings.save(user.player_id, { 'workouts.trainingpeaks.bridgeFolder': folder });
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected network');
  });
  await syncWorkoutsAutomatically(f, user.player_id);
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM zfile WHERE player_id=?').get(user.player_id)?.n, 1);
});

await test('a failed TrainingPeaks refresh retains all previously published files and zfile metadata', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Bridge Rider', '', true);
  const folder = resolve(f.config.storageDir, 'bridge');
  mkdirSync(folder);
  writeDurable(resolve(folder, 'first.zwo'), xml);
  f.settings.save(user.player_id, { 'workouts.trainingpeaks.bridgeFolder': folder });
  const workouts = new Workouts(f);
  await workouts.sync(user.player_id);
  const target = resolve(f.profiles.folder(user.player_id), 'customworkouts/trainingpeaks-first.zwo');
  const before = readFileSync(target);
  const rows = f.accounts.db.prepare('SELECT * FROM zfile').all();
  writeDurable(resolve(folder, 'first.zwo'), xml.replace('Tempo', 'Changed'), true);
  writeDurable(resolve(folder, 'second.zwo'), '<broken>');
  await syncWorkoutsAutomatically(f, user.player_id);
  assert.deepEqual(readFileSync(target), before);
  assert.deepEqual(f.accounts.db.prepare('SELECT * FROM zfile').all(), rows);
});

await test('automatic sync deadline aborts provider work and never publishes a late response', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Deadline Rider', '', true);
  new Connections(f.config.storageDir).save(user.player_id, 'intervals', ['123', 'key']);
  const workouts = new Workouts(f);
  const before = Buffer.from('{"provider":"intervals-icu","workouts":[]}');
  writeDurable(workouts.metadataFile(user.player_id), before);
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 5000);

    return timeout(10);
  });
  let aborted = false;
  t.mock.method(
    globalThis,
    'fetch',
    (_input: URL | string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        assert.ok(init?.signal);
        init.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('deadline'));
          },
          { once: true },
        );
      }),
  );
  // Keep this test alive until the unref'ed AbortSignal timer fires.
  const keepAlive = setInterval(() => {}, 1000);

  try {
    await syncWorkoutsAutomatically(f, user.player_id);
  } finally {
    clearInterval(keepAlive);
  }

  assert.equal(aborted, true);
  assert.deepEqual(readFileSync(workouts.metadataFile(user.player_id)), before);
});
