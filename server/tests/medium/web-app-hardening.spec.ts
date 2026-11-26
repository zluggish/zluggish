import { WebSessionsService } from '#src/services/web-session.service';
import { ManagementService } from '#src/services/management.service';
import { ActivitiesService } from '#src/services/activities.service';
import { JobsService } from '#src/services/jobs.service';
import { RideCompletionService } from '#src/services/ride-completion.service';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { create } from '@bufbuild/protobuf';
import { validateConfig } from '#src/config/index';
import { packageRoot } from '#src/config/load';
import { createWebApp } from '#src/http/web-app';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { Simulation } from '#src/world/simulation';
import { worldTime } from '#src/world/state';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { binary, mediumFixture, mediumWeb } from '#tests/medium/support';
import { runtimeFixture } from '#tests/support/runtime';
import { Schema, Effect } from 'effect';
import { responseStatus } from '#tests/support/html';

const flush = () => Promise.resolve();

async function json(request: Response | Promise<Response>): Promise<any> {
  const response = await request;

  return response.json();
}

await test('requests without cookies allocate no web sessions, and anonymous writes need the CSRF cookie', async (t) => {
  const f = runtimeFixture(t);
  const web = createWebApp(f);
  const sessions = f.effects.runSync(WebSessionsService);

  for (let i = 0; i < 200; i++) {
    assert.equal(await responseStatus(web.request('http://local:8080/api/setup')), 200);
  }
  assert.equal(sessions.sessions.size, 0);

  const state = await web.request('http://local:8080/api/setup');
  const { csrf } = await state.json();
  const cookie = state.headers.getSetCookie()[0]!.split(';', 1)[0]!;

  const setup = (headers: Record<string, string>) =>
    web.request('http://local:8080/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://local:8080', ...headers },
      body: JSON.stringify({
        mode: 'new',
        key: f.effects.runSync(ManagementService.use((management) => management.issueSetupKey())),
        username: 'owner',
        first_name: 'First',
        last_name: 'Rider',
        password: 'test-password',
      }),
    });

  // The token alone, or a cookie for another token, is refused.
  assert.equal(await responseStatus(setup({ 'X-CSRF-Token': csrf })), 403);
  assert.equal(await responseStatus(setup({ Cookie: cookie, 'X-CSRF-Token': 'x'.repeat(43) })), 403);
  // A page on another host is refused even with a valid token.
  assert.equal(
    await responseStatus(setup({ Cookie: cookie, 'X-CSRF-Token': csrf, Origin: 'https://evil.example' })),
    403,
  );
  assert.equal(sessions.sessions.size, 0);
  // A TLS-terminating proxy forwards the https page's requests over http.
  const signedIn = await setup({ Cookie: cookie, 'X-CSRF-Token': csrf, Origin: 'https://local:8080' });
  assert.equal(signedIn.status, 200);
  assert.equal(sessions.sessions.size, 1);
});

await test('recent server logs are available only to administrators and are never cached', async (t) => {
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

  const rider = await f.accounts.create('Regular Rider', 'test-password', 'rider');
  const url = '/api/manage/server/logs';
  const log = f.world.lifecycle.log;
  log.info('server.test', 'Recent server entry', { token: 'secret-value' });

  const admin = mediumWeb(f, owner);

  assert.equal(await responseStatus(admin.app.request(url)), 401);
  assert.equal(await responseStatus(mediumWeb(f, rider).request(url)), 403);
  const response = await admin.request(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const { entries } = await response.json();
  assert.match(entries[0], /Recent server entry/);
  assert.doesNotMatch(entries[0], /secret-value/);

  log.warn('server.test', 'New server entry');
  const refreshed = await json(admin.request(url));

  assert.match(refreshed.entries[0], /New server entry/);
  assert.equal(refreshed.entries[1], entries[0]);
});

await test('login names match after Unicode normalization, and similar imported names stay ambiguous', async (t) => {
  const f = runtimeFixture(t);
  const imported = await f.accounts.create('Åsa Rider', 'test-password', 'ÅSA');
  assert.equal(f.accounts.byUsername('ÅSA')?.player_id, imported.player_id);
  assert.equal(f.accounts.byUsername('åsa')?.player_id, imported.player_id);
  assert.equal(f.accounts.loginNameTaken('åsa'), true);
  assert.equal(f.accounts.loginNameTaken('åsa', imported.player_id), false);

  const upper = await f.accounts.create('Anna Upper', 'test-password', 'ANNA');
  const mixed = await f.accounts.create('Anna Mixed', 'test-password', 'Anna');
  assert.equal(f.accounts.byUsername('ANNA')?.player_id, upper.player_id);
  assert.equal(f.accounts.byUsername('Anna')?.player_id, mixed.player_id);
  assert.equal(f.accounts.byUsername('anna'), null);
  assert.equal(f.accounts.loginNameTaken('anna'), true);

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

  const opened = Effect.runSync(service.sessions.create(f.accounts.identityOf(owner), Date.now() + 900_000));
  await assert.rejects(
    f.effects.runPromise(
      service.create(
        opened.id,
        { username: 'anna', first_name: 'Third', last_name: 'Anna', password: 'test-password' },
        crypto.randomUUID(),
      ),
    ),
    /Login name already exists/,
  );
});

await test('disabled and passwordless riders cost the same password work as other riders', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Timed Rider', 'test-password', 'timed');
  f.accounts.db.exec(`UPDATE user SET enabled=0 WHERE player_id=${rider.player_id}`);
  const hashing = t.mock.method(f.accounts.repositories.cryptoRepository, 'hashPassword');
  assert.equal(await f.accounts.verify(f.accounts.get(rider.player_id)!, 'test-password'), false);
  assert.equal(hashing.mock.callCount(), 1);
});

await test('bot commands run only from the management area, once per operation', async (t) => {
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

  const simulation = new Simulation(f, () => 100);
  t.after(() => simulation.close());
  await simulation.ready;
  const id = BigInt(owner.player_id);
  assert.equal(simulation.command(id, 'group'), 'Use the web app management area for server commands.');
  assert.equal(simulation.command(id, 'peloton 5'), 'Use the web app management area for server commands.');

  const opened = Effect.runSync(service.sessions.create(f.accounts.identityOf(owner), Date.now() + 900_000));
  const sent: Array<string> = [];

  const dispatch = {
    reload: flush,
    bots: (rider: number, command: string) => {
      sent.push(`${rider}:${command}`);

      return simulation.command(BigInt(rider), command, true);
    },
  };

  const operation = crypto.randomUUID();
  const input = { operation, user: owner.player_id, command: 'group' as const };
  await assert.rejects(
    f.effects.runPromise(service.serverOperation(opened.id, 'bots', input, flush, dispatch)),
    /riding now/,
  );
  f.world.online.set(id, create(PlayerStateSchema, { id, worldTime: worldTime() }));

  const second = { ...input, operation: crypto.randomUUID() };

  const outcomes = await Promise.all([
    f.effects.runPromise(service.serverOperation(opened.id, 'bots', second, flush, dispatch)),
    f.effects.runPromise(service.serverOperation(opened.id, 'bots', second, flush, dispatch)),
  ]);

  assert.deepEqual(sent, [`${owner.player_id}:group`]);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ['complete', 'unknown'],
  );
  assert.deepEqual(
    await f.effects.runPromise(service.serverOperation(opened.id, 'bots', second, flush, dispatch)),
    outcomes[0],
  );
  await assert.rejects(
    f.effects.runPromise(
      service.serverOperation(opened.id, 'bots', { ...second, command: 'disperse' }, flush, dispatch),
    ),
    /Operation changed/,
  );
});

await test('administrators can dispatch after the old confirmation deadline; retries dispatch only once', async (t) => {
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

  const opened = Effect.runSync(service.sessions.create(f.accounts.identityOf(owner), Date.now() + 900_000));
  let reloads = 0;

  const dispatch = {
    reload: () => {
      reloads++;

      return Promise.resolve();
    },
    bots: () => '',
  };

  const input = { operation: crypto.randomUUID() };

  const lapse = () => {
    opened.session.confirmedUntil = 0;

    return Promise.resolve();
  };

  const result = await f.effects.runPromise(service.serverOperation(opened.id, 'reload-bots', input, lapse, dispatch));
  assert.equal(result.ok, true);
  opened.session.confirmedUntil = Date.now() + 900_000;
  const retry = await f.effects.runPromise(service.serverOperation(opened.id, 'reload-bots', input, flush, dispatch));
  assert.equal(retry.ok, true);
  assert.equal(reloads, 1);
});

await test('ride completion rejects malformed ride identities with 400', async (t) => {
  const f = runtimeFixture(t);

  for (const path of ['/api/profiles/abc/activities/1', '/api/profiles/1/activities/nope']) {
    assert.equal(
      await responseStatus(
        f.app.request(path, { method: 'PUT', headers: { Authorization: 'Bearer stale' }, body: 'x' }),
      ),
      400,
    );
  }
});

await test('the game app bundle contains no web app code', () => {
  const game = resolve(packageRoot(), '../web/dist/game');
  const assets = resolve(game, 'client/assets');

  const bundles = [
    ...readdirSync(assets)
      .filter((name) => name.endsWith('.js'))
      .map((name) => resolve(assets, name)),
    resolve(game, 'server/entry.js'),
  ];

  for (const file of bundles) {
    const text = readFileSync(file, 'utf8');

    for (const marker of [
      '/api/manage',
      '/api/session',
      '/api/me',
      'Confirm your password to manage',
      'activities_list_load_error',
      'login_without_password',
    ]) {
      assert.equal(text.includes(marker), false, `${file} contains ${marker}`);
    }
  }
});

await test('a public URL pins the accepted origin and marks https cookies Secure', async (t) => {
  const f = runtimeFixture(t);

  const config = validateConfig({
    storageDir: f.config.storageDir,
    network: { web: { publicUrl: 'https://zluggish.example.com' } },
  });

  const web = createWebApp({ ...f, config });

  const state = await web.request('http://local:8080/api/setup');
  const { csrf } = await state.json();
  const cookie = state.headers.getSetCookie()[0]!;
  assert.match(cookie, /; Secure/);

  const check = (origin: string) =>
    web.request('http://local:8080/api/setup/key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        Cookie: cookie.split(';', 1)[0]!,
        'X-CSRF-Token': csrf,
      },
      body: JSON.stringify({
        key: f.effects.runSync(ManagementService.use((management) => management.issueSetupKey())),
      }),
    });

  // The request host no longer decides: only the configured address passes.
  assert.equal(await responseStatus(check('https://local:8080')), 403);
  assert.equal(await responseStatus(check('https://zluggish.example.com:8443')), 403);
  assert.equal(await responseStatus(check('https://zluggish.example.com')), 200);
});

await test('imported activities without completion records rebuild missing charts from their FIT payload', async (t) => {
  const f = await mediumFixture(t);
  const fit = readFileSync(new URL('../fixtures/ride.fit', import.meta.url));

  const { lastInsertRowid: id } = f.accounts.db
    .prepare('INSERT INTO activity (player_id, name, fit, distanceInMeters) VALUES (?, ?, ?, 3000)')
    .run(f.rider.player_id, 'Imported ride', fit);

  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM activity_completion').get()?.n, 0);

  const pending = f.effects.runSync(
    ActivitiesService.use((service) => service.ownDetail(f.rider.player_id, String(id))),
  );

  assert.equal(pending.chartPending, true);
  // Repeated detail requests must share the same pending chart job.
  f.effects.runSync(ActivitiesService.use((service) => service.ownDetail(f.rider.player_id, String(id))));
  assert.equal(f.accounts.db.prepare("SELECT count(*) AS n FROM job WHERE type='chart'").get()?.n, 1);
  await f.effects.runPromise(JobsService.use((service) => service.drain()));

  const detail = f.effects.runSync(
    ActivitiesService.use((service) => service.ownDetail(f.rider.player_id, String(id))),
  );

  assert.equal(detail.chartPending, false);
  const { timeInSec } = Schema.decodeUnknownSync(Schema.Struct({ timeInSec: Schema.Array(Schema.Finite) }))(
    detail.chart,
  );
  assert.ok(timeInSec.length > 0);
});

await test('web app lists an activity whose Strava ids exceed 32 bits', async (t) => {
  const f = await mediumFixture(t);
  const web = createWebApp(f);

  const data = {
    playerId: BigInt(f.rider.player_id),
    courseId: 6n,
    name: 'Strava synced',
    startDate: new Date().toISOString(),
    distanceInMeters: 3000,
    stravaUploadId: 13_104_230_872n,
    stravaActivityId: 20_937_783_035n,
  };

  const posted = await f.request(`/api/profiles/${f.rider.player_id}/activities`, {
    method: 'POST',
    ...binary(ActivitySchema, data),
  });

  const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(await posted.json());
  f.effects.runSync(
    ActivitiesService.use((service) => service.finalize(create(ActivitySchema, { ...data, id: BigInt(id) }))),
  );

  const { id: session } = f.effects.runSync(
    WebSessionsService.use((sessions) => sessions.create(f.accounts.identityOf(f.rider))),
  );

  const list = await web.request('http://local:8080/api/me/activities', {
    headers: { Cookie: `zluggish_web_session=${session}` },
  });

  assert.equal(list.status, 200);
  const body: { activities: Array<{ id: string; name: string }> } = await json(list);

  assert.deepEqual(
    body.activities.map((a) => [a.id, a.name]),
    [[String(id), 'Strava synced']],
  );
});

await test('riders list, inspect and download only their own activities in the web app', async (t) => {
  const f = await mediumFixture(t);
  const web = createWebApp(f);
  const fit = readFileSync(new URL('../fixtures/ride.fit', import.meta.url));

  const data = {
    playerId: BigInt(f.rider.player_id),
    courseId: 6n,
    name: 'Volcano loop',
    startDate: new Date().toISOString(),
    distanceInMeters: 3000,
    fitFilename: 'ride.fit',
    fit,
  };

  const posted = await f.request(`/api/profiles/${f.rider.player_id}/activities`, {
    method: 'POST',
    ...binary(ActivitySchema, data),
  });

  const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(await posted.json());
  f.effects.runSync(
    ActivitiesService.use((service) => service.finalize(create(ActivitySchema, { ...data, id: BigInt(id) }))),
  );

  const image = await f.effects.runPromise(
    ActivitiesService.use((service) =>
      service.saveImage(f.rider.player_id, String(id), new Uint8Array([0xff, 0xd8, 1])),
    ),
  );

  const as = (rider: typeof f.rider) => {
    const { id: session } = f.effects.runSync(
      WebSessionsService.use((sessions) => sessions.create(f.accounts.identityOf(rider))),
    );

    return (path: string) =>
      web.request(`http://local:8080${path}`, { headers: { Cookie: `zluggish_web_session=${session}` } });
  };

  const owner = as(f.rider);
  const other = as(f.other);

  const list: { activities: Array<{ id: string; name: string; fit: boolean; images: number; world: number }> } =
    await json(owner('/api/me/activities'));
  assert.deepEqual(
    list.activities.map((a) => [a.id, a.name, a.fit, a.images, a.world]),
    [[String(id), 'Volcano loop', true, 1, 6]],
  );
  const others = await json(other('/api/me/activities'));
  assert.deepEqual(others.activities, []);

  const pending = await json(owner(`/api/me/activities/${id}`));
  assert.deepEqual([pending.imageIds, pending.chart, pending.chartPending], [[image], null, true]);
  await f.effects.runPromise(JobsService.use((service) => service.drain()));
  const detail = await json(owner(`/api/me/activities/${id}`));
  assert.equal(detail.chartPending, false);
  assert.ok(detail.chart.timeInSec.length > 0);

  const download = await owner(`/api/me/activities/${id}/fit`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('Content-Disposition'), 'attachment; filename="ride.fit"');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), fit);

  const jpg = await owner(`/api/me/activities/${id}/images/${image}?download`);
  assert.equal(jpg.headers.get('Content-Type'), 'image/jpeg');
  assert.match(jpg.headers.get('Content-Disposition') ?? '', /attachment/);
  assert.deepEqual([...new Uint8Array(await jpg.arrayBuffer())], [0xff, 0xd8, 1]);
  assert.equal(jpg.headers.get('Content-Length'), '3');

  for (const path of [
    `/api/me/activities/${id}`,
    `/api/me/activities/${id}/fit`,
    `/api/me/activities/${id}/images/${image}`,
  ]) {
    assert.equal(await responseStatus(other(path)), 404);
  }
  assert.equal(await responseStatus(owner('/api/me/activities/1%27')), 400);
  assert.equal(await responseStatus(web.request(`http://local:8080/api/me/activities`)), 401);
});

await test('riders delete their own activities in the web app, but not a ride the game is still saving', async (t) => {
  const f = await mediumFixture(t);
  const web = createWebApp(f);

  const ride = async (name: string) => {
    const posted = await f.request(`/api/profiles/${f.rider.player_id}/activities`, {
      method: 'POST',
      ...binary(ActivitySchema, {
        playerId: BigInt(f.rider.player_id),
        courseId: 6n,
        name,
        startDate: new Date().toISOString(),
        distanceInMeters: 100,
      }),
    });

    return String(Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(await posted.json()).id);
  };

  const kept = await ride('Kept');
  const deleted = await ride('Deleted');
  const riding = await ride('Riding');

  const as = (rider: typeof f.rider) => {
    const { id: session, session: state } = f.effects.runSync(
      WebSessionsService.use((sessions) => sessions.create(f.accounts.identityOf(rider))),
    );

    return (path: string, method = 'GET') =>
      web.request(`http://local:8080${path}`, {
        method,
        headers: {
          Cookie: `zluggish_web_session=${session}`,
          'Content-Type': 'application/json',
          'X-CSRF-Token': state.csrf,
          Origin: 'https://local:8080',
        },
      });
  };

  const owner = as(f.rider);
  const other = as(f.other);

  assert.equal(await responseStatus(other(`/api/me/activities/${deleted}`, 'DELETE')), 404);
  assert.equal(await responseStatus(owner('/api/me/activities/1%27', 'DELETE')), 400);

  const response = await owner(`/api/me/activities/${deleted}`, 'DELETE');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true });
  assert.equal(await responseStatus(owner(`/api/me/activities/${deleted}`)), 404);
  assert.equal(await responseStatus(owner(`/api/me/activities/${deleted}`, 'DELETE')), 404);

  f.effects.runSync(
    RideCompletionService.use((service) =>
      service.grant(f.rider.player_id, {
        activity: BigInt(riding),
        token: '',
        generation: 0,
        key: Buffer.alloc(0),
        deadline: Date.now() + 60_000,
        lastSeen: Date.now(),
      }),
    ),
  );
  assert.equal(await responseStatus(owner(`/api/me/activities/${riding}`, 'DELETE')), 409);

  const list: { activities: Array<{ id: string }> } = await json(owner('/api/me/activities'));
  assert.deepEqual(list.activities.map((a) => a.id).sort(), [kept, riding].sort());
});

await test('web app lists the climb portals a rider has ridden with the best time and latest ride', async (t) => {
  const f = await mediumFixture(t);
  const web = createWebApp(f);

  const insert = f.accounts.db.prepare(
    'INSERT INTO route_result(player_id,route_hash,world_time,elapsed_ms) VALUES (?,?,?,?)',
  );

  // 10052 is Alto de Patios; the ride without a time must not count as a best time.
  insert.run(f.rider.player_id, 10_052, 380_000_000_000, 600_000);
  insert.run(f.rider.player_id, 10_052, 381_000_000_000, 540_000);
  insert.run(f.rider.player_id, 10_052, 379_000_000_000, null);
  insert.run(f.rider.player_id, 3_114_603_308, 381_000_000_000, 1000);
  insert.run(f.other.player_id, 10_011, 381_000_000_000, 700_000);

  const { id: session } = f.effects.runSync(
    WebSessionsService.use((sessions) => sessions.create(f.accounts.identityOf(f.rider))),
  );

  const response = await web.request('http://local:8080/api/me/climbs', {
    headers: { Cookie: `zluggish_web_session=${session}` },
  });

  assert.equal(response.status, 200);
  const body = await json(response);

  assert.equal(body.total, 57);
  assert.deepEqual(body.climbs, [
    {
      road: '10052',
      name: 'Alto de Patios',
      distanceKm: 5.9,
      elevationM: 376,
      rides: 3,
      bestMs: 540_000,
      strava: { watopia: 41_290_767, france: 41_290_943 },
      lastRide: '2026-11-18T15:34:35.000Z',
      category: '2',
      avgGradePct: 6.4,
      maxGradePct: null,
      elevationLowM: null,
      elevationHighM: null,
      profileSource: 'estimated',
      profile: [
        [0, 0],
        [5900, 376],
      ],
    },
  ]);
});

await test('every climb with Strava segments is a climb of the launcher, with no segment used twice', () => {
  const climbs = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String, road: Schema.String })))(
    JSON.parse(readFileSync(resolve(packageRoot(), '../assets/data/climbs.txt'), 'utf8')),
  );

  const segments = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Struct({ watopia: Schema.Finite, france: Schema.Finite })),
  )(JSON.parse(readFileSync(resolve(packageRoot(), '../assets/data/climb_segments.txt'), 'utf8')));

  const roads = new Set(climbs.map((climb) => climb.road));
  const ids = Object.values(segments).flatMap((segment) => [segment.watopia, segment.france]);

  assert.ok(
    Object.keys(segments).every((road) => roads.has(road)),
    'every mapped road is a climb of the launcher',
  );
  assert.equal(new Set(ids).size, ids.length, 'no segment belongs to two climbs');
  assert.equal(segments['10052']?.watopia, 41_290_767);
});
