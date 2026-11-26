import { DocumentsService } from '#src/services/documents.service';
import { LoginRequestSchema, LoginResponseSchema } from '#src/protocol/generated/login_pb';
import { AchievementsSchema, PlayerProfileSchema, StreaksSchema } from '#src/protocol/generated/profile_pb';
import { UserStorageSchema } from '#src/protocol/generated/user_storage_pb';
import { AssetFiles } from '#src/repositories/files.repository';
import { ImportsService } from '#src/services/profile-import.service';
import { WorkoutsService } from '#src/services/workout.service';
import { runtimeFixture } from '#tests/support/runtime';
import { mediumWeb } from '#tests/medium/support';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

await test('all rider state files stage, cancel, publish and recover with durable backups', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Import Rider', 'test-password');
  const imports = f.effects.runSync(ImportsService);

  const files = {
    'profile.bin': toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 99n, firstName: 'Imported' })),
    'achievements.bin': toBinary(AchievementsSchema, create(AchievementsSchema)),
    'economy_config.txt': Buffer.from('{"cycling_levels":[],"f3":0,"f4":0,"f5":0}'),
    'user_storage.bin': toBinary(UserStorageSchema, create(UserStorageSchema)),
    'streaks.bin': toBinary(StreaksSchema, create(StreaksSchema, { curStreak: 3 })),
  };

  const old = toBinary(StreaksSchema, create(StreaksSchema, { curStreak: 1 }));

  const streaks = () =>
    fromBinary(
      StreaksSchema,
      f.effects.runSync(DocumentsService.use((service) => service.get(user.player_id, 'streaks.bin'))) ??
        new Uint8Array(),
    );

  f.effects.runSync(DocumentsService.use((service) => service.put(user.player_id, 'streaks.bin', old)));
  const canceled = f.effects.runSync(imports.prepare(user, files));
  f.effects.runSync(imports.cancel(user, canceled));
  assert.equal(streaks().curStreak, 1);
  const stage = f.effects.runSync(imports.prepare(user, files));
  assert.equal(f.effects.runSync(imports.inspect(user, stage)).files.length, 5);
  f.effects.runSync(imports.publish(user, stage, false));
  assert.equal(f.profiles.get(user.player_id).id, BigInt(user.player_id));
  assert.equal(f.profiles.get(user.player_id).firstName, 'Imported');
  assert.equal(f.accounts.get(user.player_id)?.first_name, 'Imported');
  assert.equal(streaks().curStreak, 3);
  assert.ok(
    readdirSync(f.profiles.folder(user.player_id)).some(
      (name) => name.startsWith('streaks.bin.') && name.endsWith('.bak'),
    ),
  );
  const fresh = f.accounts.get(user.player_id);
  assert.ok(fresh);

  // A crash after the publication commit leaves its stage behind: recovery removes it,
  // and the stage cannot apply a second time.
  const repeated = f.effects.runSync(imports.prepare(fresh, { 'streaks.bin': old }));
  const folder = f.effects.runSync(imports.folder(fresh, repeated));
  const manifest = f.effects.runSync(imports.inspect(fresh, repeated));
  f.effects.runSync(imports.publish(fresh, repeated, false));
  assert.equal(streaks().curStreak, 1);
  f.effects.runSync(
    DocumentsService.use((service) => service.put(user.player_id, 'streaks.bin', files['streaks.bin'])),
  );
  mkdirSync(folder);
  new AssetFiles().writeDurable(resolve(folder, 'streaks.bin'), old);
  new AssetFiles().writeDurable(resolve(folder, 'manifest.json'), JSON.stringify(manifest));
  f.effects.runSync(ImportsService.use((service) => service.recover()));
  assert.equal(existsSync(folder), false);
  assert.equal(streaks().curStreak, 3);
  assert.throws(() => f.effects.runSync(imports.prepare(fresh, { 'user_storage.bin': new Uint8Array([255]) })));
  assert.throws(() =>
    f.effects.runSync(imports.prepare(fresh, { 'economy_config.txt': Buffer.from('{"cycling_levels":"invalid"}') })),
  );
});

await test('web restore accepts empty protobuf state and waits for review before publishing', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Restore Rider', 'test-password');
  const web = mediumWeb(f, user);
  const form = new FormData();
  form.set('user_storage.bin', new File([], 'user_storage.bin'));
  form.set('streaks.bin', new File([], 'streaks.bin'));
  const response = await web.request('/api/me/import', 'POST', form);
  assert.equal(response.status, 200);
  const { review } = await response.json();
  assert.ok(review.stage);
  assert.equal(f.effects.runSync(DocumentsService.use((service) => service.has(user.player_id, 'streaks.bin'))), false);
  const published = await web.request('/api/me/import/confirm', 'POST', { stage: review.stage, confirmSource: true });
  assert.equal(published.status, 200);
  assert.equal(
    f.effects.runSync(DocumentsService.use((service) => service.get(user.player_id, 'streaks.bin')))?.length,
    0,
  );
  assert.equal(
    f.effects.runSync(DocumentsService.use((service) => service.get(user.player_id, 'user_storage.bin')))?.length,
    0,
  );
});

await test('Zwift connection encrypts secrets and official downloads stage a rider-preserving import', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Local Rider', 'test-password');
  const web = mediumWeb(f, user);

  const saved = await web.request('/api/me/zwift', 'PUT', {
    username: 'official@example.test',
    password: 'super-secret',
    upload: true,
    click: true,
  });

  assert.doesNotMatch(await saved.text(), /super-secret|official@example.test/);
  const connections = f.accounts.repositories.connectionsRepository;
  assert.deepEqual(connections.read(user.player_id, 'zwift'), ['official@example.test', 'super-secret']);
  assert.equal(
    Buffer.from(
      f.effects.runSync(DocumentsService.use((service) => service.get(user.player_id, 'zwift_credentials.bin'))) ?? [],
    ).includes(Buffer.from('super-secret')),
    false,
  );
  assert.equal(f.settings.read(user.player_id)['uploads.zwift.enabled'], true);
  assert.equal(f.settings.read(user.player_id)['devices.zwiftClick.enabled'], true);
  const calls: Array<string> = [];
  t.mock.method(globalThis, 'fetch', (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);

    if (url.endsWith('/access/codes')) {
      return Promise.resolve(Response.json({ access_token: 'test-token', refresh_token: 'refresh' }));
    }

    if (url.endsWith('/tokens/logout')) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-token');

    if (url.endsWith('/api/profiles/me')) {
      return Promise.resolve(
        new Response(toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 999n, firstName: 'Official' }))),
      );
    }

    if (url.endsWith('/api/users/login')) {
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
    }

    if (url.endsWith('/api/achievement/loadPlayerAchievements')) {
      return Promise.resolve(
        new Response(toBinary(AchievementsSchema, create(AchievementsSchema, { achievements: [{ id: 59 }] }))),
      );
    }
    throw new Error(`Unexpected request ${url}`);
  });
  const downloaded = await web.request('/api/me/zwift/import', 'POST', { profile: true, achievements: true });
  assert.equal(downloaded.status, 200);
  const { review } = await downloaded.json();
  assert.equal(f.profiles.get(user.player_id).firstName, 'Local');
  const confirm = await web.request('/api/me/import/confirm', 'POST', { stage: review.stage });
  assert.equal(confirm.status, 200);
  assert.equal(f.profiles.get(user.player_id).id, BigInt(user.player_id));
  assert.equal(f.profiles.get(user.player_id).firstName, 'Official');
  assert.equal(f.accounts.get(user.player_id)?.official_player_id, '999');
  assert.ok(calls.some((url) => url.endsWith('/tokens/logout')));
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(null, { status: 503 })));
  const failed = await web.request('/api/me/zwift/import', 'POST', { profile: true, achievements: false });
  assert.equal(failed.status, 400);
  const { message } = await failed.json();
  assert.match(message, /Download failed/);
  assert.equal(f.profiles.get(user.player_id).firstName, 'Official');
  const pending = await web.request('/api/me/import');
  const { review: remaining } = await pending.json();
  assert.equal(remaining, null);
});

const xml =
  '<workout_file><name>Tempo</name><sportType>bike</sportType><workout><SteadyState Duration="600" Power="0.8"/></workout></workout_file>';

await test('automatic home and Android login sync coalesce, preserve UUIDs and expose cycling-only schedules', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Planned Rider', 'test-password');
  f.accounts.repositories.connectionsRepository.save(user.player_id, 'intervals', ['123', 'key']);
  const headers = { Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}` };
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  let eventRequests = 0;
  t.mock.method(globalThis, 'fetch', (input: URL | string) => {
    if (String(input).endsWith('/download.zwo')) {
      return Promise.resolve(new Response(xml));
    }
    if (!String(input).includes('/events?')) {
      // The athlete settings (FTP, zones) a sync reads besides the events.
      return Promise.resolve(Response.json({}));
    }
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
  const workouts = f.effects.runSync(WorkoutsService);
  const id = f.effects.runSync(workouts.list(user.player_id))[0]?.id;
  assert.ok(id);
  f.world.logout(BigInt(user.player_id));
  await f.app.request('/api/users/login', {
    method: 'POST',
    headers: { ...headers, 'User-Agent': 'Android' },
    body: toBinary(LoginRequestSchema, create(LoginRequestSchema, { key: new Uint8Array(16) })),
  });
  assert.equal(eventRequests, 2);
  assert.equal(f.effects.runSync(workouts.list(user.player_id))[0]?.id, id);

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

      if (cycling) {
        assert.notDeepEqual(body, empty);
      } else {
        assert.deepEqual(body, empty);
      }
    }

    const detail = await f.app.request(`/api/workout/workouts/${id}?sport=${sport || 'CYCLING'}`, { headers });
    assert.equal(detail.status, cycling ? 200 : 404);
  }

  const before = readFileSync(f.effects.runSync(workouts.metadataFile(user.player_id)));
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
  const aborted = f.effects.runPromise(workouts.sync(user.player_id, controller.signal));
  controller.abort();
  await assert.rejects(aborted);
  assert.deepEqual(readFileSync(f.effects.runSync(workouts.metadataFile(user.player_id))), before);
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(null, { status: 503 })));
  f.world.logout(BigInt(user.player_id));

  const failure = await f.app.request('/api/users/login', {
    method: 'POST',
    headers: { ...headers, 'User-Agent': 'Android' },
    body: toBinary(LoginRequestSchema, create(LoginRequestSchema, { key: new Uint8Array(16) })),
  });

  assert.equal(failure.status, 200);
  assert.deepEqual(readFileSync(f.effects.runSync(workouts.metadataFile(user.player_id))), before);
});

await test('automatic TrainingPeaks home refresh imports exported workouts without contacting a provider', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Bridge Rider', 'test-password');
  const folder = resolve(f.config.storageDir, 'bridge');
  mkdirSync(folder);
  new AssetFiles().writeDurable(resolve(folder, 'tempo.zwo'), xml);
  f.settings.save(user.player_id, { 'workouts.trainingpeaks.bridgeFolder': folder });
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected network');
  });
  await f.effects.runPromise(WorkoutsService.use((workouts) => workouts.syncWorkoutsAutomatically(user.player_id)));
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM zfile WHERE player_id=?').get(user.player_id)?.n, 1);
});

await test('a failed TrainingPeaks refresh retains all previously published files and zfile metadata', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Bridge Rider', 'test-password');
  const folder = resolve(f.config.storageDir, 'bridge');
  mkdirSync(folder);
  new AssetFiles().writeDurable(resolve(folder, 'first.zwo'), xml);
  f.settings.save(user.player_id, { 'workouts.trainingpeaks.bridgeFolder': folder });
  const workouts = f.effects.runSync(WorkoutsService);
  await f.effects.runPromise(workouts.sync(user.player_id));
  const target = resolve(f.profiles.folder(user.player_id), 'customworkouts/trainingpeaks-first.zwo');
  const before = readFileSync(target);
  const rows = f.accounts.db.prepare('SELECT * FROM zfile').all();
  new AssetFiles().writeDurable(resolve(folder, 'first.zwo'), xml.replace('Tempo', 'Changed'), true);
  new AssetFiles().writeDurable(resolve(folder, 'second.zwo'), '<broken>');
  await f.effects.runPromise(WorkoutsService.use((workouts) => workouts.syncWorkoutsAutomatically(user.player_id)));
  assert.deepEqual(readFileSync(target), before);
  assert.deepEqual(f.accounts.db.prepare('SELECT * FROM zfile').all(), rows);
});

await test('automatic sync deadline aborts provider work and never publishes a late response', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Deadline Rider', 'test-password');
  f.accounts.repositories.connectionsRepository.save(user.player_id, 'intervals', ['123', 'key']);
  const workouts = f.effects.runSync(WorkoutsService);
  const before = Buffer.from('{"provider":"intervals-icu","workouts":[]}');
  new AssetFiles().writeDurable(f.effects.runSync(workouts.metadataFile(user.player_id)), before);
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
    await f.effects.runPromise(WorkoutsService.use((workouts) => workouts.syncWorkoutsAutomatically(user.player_id)));
  } finally {
    clearInterval(keepAlive);
  }

  assert.equal(aborted, true);
  assert.deepEqual(readFileSync(f.effects.runSync(workouts.metadataFile(user.player_id))), before);
});

await test('home marks the climb portals this rider has already ridden', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Climber One', 'test-password');
  const other = await f.accounts.create('Climber Two', 'test-password');
  const insert = f.accounts.db.prepare('INSERT INTO route_result(player_id,route_hash) VALUES (?,?)');
  // 10052 is Alto de Patios. A hash outside the climb range and another rider's result must not mark anything.
  insert.run(rider.player_id, 10_052);
  insert.run(rider.player_id, 10_052);
  insert.run(rider.player_id, 3_114_603_308);
  insert.run(other.player_id, 10_011);

  const home = await f.app.request(`/user/${rider.username}/`, {
    headers: { Authorization: `Bearer ${f.sessions.tokens(rider, f.tokens).access_token}` },
  });

  assert.equal(home.status, 200);
  const html = await home.text();

  assert.match(html, />✓ Alto de Patios/);
  assert.match(html, />Bealach na Ba/);
  const marked = new Set(html.matchAll(/✓ ([^<"]+)/g).map((match) => match[1]));

  assert.deepEqual([...marked], ['Alto de Patios (5.9 km / 376 m)']);
});
