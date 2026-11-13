import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { mediumFixture, mediumBrowser, binary, decode } from '#tests/medium/support';
import { LoginRequestSchema, LoginResponseSchema } from '#src/protocol/generated/login_pb';
import { ZFilesProtoSchema } from '#src/protocol/generated/zfiles_pb';
import { createCdn } from '#src/node/network/cdn';
import { writeDurable } from '#src/repositories/files.repository';

const xml =
  '<workout_file><name>Medium Tempo</name><sportType>bike</sportType><workout><SteadyState Duration="600" Power="0.8"/></workout></workout_file>';

const day = '2026-11-13';
const schedules = z.array(z.object({ workoutId: z.string(), workoutUri: z.string(), scheduleId: z.string() }));

await test('F07 browser home and Android login share one refresh; saved-token logins refresh again with stable workout IDs', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 13, 12) });
  const f = await mediumFixture(t);
  const browser = await mediumBrowser(f);
  const connected = await browser.form(`/intervals/${f.rider.username}/`, { athlete_id: '123', api_key: 'medium-key' });
  assert.equal(connected.status, 302);
  const calls: { url: URL; signal: AbortSignal | null | undefined }[] = [];

  t.mock.method(globalThis, 'fetch', async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, signal: init?.signal });
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      `Basic ${Buffer.from('API_KEY:medium-key').toString('base64')}`,
    );
    await Promise.resolve();

    if (url.pathname.endsWith('/download.zwo')) return new Response(xml);
    assert.equal(url.pathname, '/api/v1/athlete/123/events');
    assert.equal(url.searchParams.get('oldest'), day);
    assert.equal(url.searchParams.get('newest'), day);

    return Response.json([{ id: 42, name: 'Medium Tempo', start_date_local: `${day}T08:00:00`, category: 'WORKOUT' }]);
  });

  const [home, login] = await Promise.all([
    browser.request(`/user/${f.rider.username}/`),
    f.request('/api/users/login', {
      method: 'POST',
      ...binary(LoginRequestSchema, { key: new Uint8Array(16) }),
      headers: { 'User-Agent': 'Zwift Android' },
    }),
  ]);

  assert.equal(home.status, 200);
  assert.match(await home.text(), /select name="climb"/);
  const relay = await decode(login, LoginResponseSchema);
  assert.equal(relay.relaySessionId, f.rider.player_id);
  assert.equal(calls.length, 2);
  assert.ok(calls[0]?.signal);
  assert.equal(calls[0]?.signal, calls[1]?.signal);
  const listed = await f.request('/api/workout/schedule/list');
  const [first] = schedules.parse(await listed.json());
  assert.ok(first);
  const asset = await createCdn(f).request(new URL(first.workoutUri).pathname);
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /Medium Tempo/);
  const loggedOut = await f.request('/api/users/logout', { method: 'POST' });
  assert.equal(loggedOut.status, 204);

  const savedToken = await f.request('/api/users/login', {
    method: 'POST',
    ...binary(LoginRequestSchema, { key: new Uint8Array(16) }),
    headers: { 'User-Agent': 'Zwift Android' },
  });

  await decode(savedToken, LoginResponseSchema);
  assert.equal(calls.length, 4);
  const refreshed = await f.request('/api/workout/schedule/list');
  assert.deepEqual(schedules.parse(await refreshed.json()), [first]);
  const other = await f.request('/api/workout/schedule/list', {}, f.other);
  assert.deepEqual(await other.json(), []);
});

for (const failure of ['provider unavailable', 'invalid second download']) {
  await test(`F07 failed automatic refresh preserves cached XML and metadata: ${failure}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 13, 12) });
    const f = await mediumFixture(t);
    const browser = await mediumBrowser(f);
    await browser.form(`/intervals/${f.rider.username}/`, { athlete_id: '123', api_key: 'medium-key' });
    let failing = false;

    t.mock.method(globalThis, 'fetch', (input: URL | string) => {
      const url = String(input);

      if (failing && failure === 'provider unavailable') return Promise.resolve(new Response(null, { status: 503 }));

      if (url.endsWith('/events/43/download.zwo')) return Promise.resolve(new Response('<broken>'));

      if (url.endsWith('/download.zwo'))
        return Promise.resolve(new Response(failing ? xml.replace('Medium Tempo', 'Changed') : xml));
      const events = [{ id: 42, start_date_local: `${day}T08:00:00` }];

      if (failing) events.push({ id: 43, start_date_local: `${day}T09:00:00` });

      return Promise.resolve(Response.json(events));
    });

    const synced = await browser.request(`/user/${f.rider.username}/`);
    assert.equal(synced.status, 200);
    const cache = resolve(f.config.storageDir, 'tp-workouts/intervalsicu');
    const files = readdirSync(cache);
    const before = files.map((name) => readFileSync(resolve(cache, name)));
    const metadata = resolve(f.profiles.folder(f.rider.player_id), 'intervals_icu_workout.json');
    const saved = readFileSync(metadata);
    failing = true;

    const response = await f.request('/api/users/login', {
      method: 'POST',
      ...binary(LoginRequestSchema, { key: new Uint8Array(16) }),
      headers: { 'User-Agent': 'Android' },
    });

    await decode(response, LoginResponseSchema);
    assert.deepEqual(readFileSync(metadata), saved);
    assert.deepEqual(readdirSync(cache), files);
    assert.deepEqual(
      files.map((name) => readFileSync(resolve(cache, name))),
      before,
    );
    const retained = await f.request('/api/workout/schedule/list');
    assert.equal(schedules.parse(await retained.json()).length, 1);
  });
}

await test('F07 automatic login deadline cancels provider work without replacing the cached schedule', async (t) => {
  const f = await mediumFixture(t);
  const browser = await mediumBrowser(f);
  await browser.form(`/intervals/${f.rider.username}/`, { athlete_id: '123', api_key: 'medium-key' });
  const metadata = resolve(f.profiles.folder(f.rider.player_id), 'intervals_icu_workout.json');
  const before = Buffer.from('{"provider":"intervals-icu","workouts":[]}');
  writeDurable(metadata, before);
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 5000);

    return originalTimeout(25);
  });
  let aborted = false;
  t.mock.method(
    globalThis,
    'fetch',
    (_input: URL | string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        assert.ok(init?.signal);

        const cancel = () => {
          aborted = true;
          reject(new Error('provider canceled'));
        };

        if (init.signal.aborted) cancel();
        else init.signal.addEventListener('abort', cancel, { once: true });
      }),
  );
  // AbortSignal's timer is unref'ed; keep the test alive until the deadline fires.
  const keepAlive = setTimeout(() => {}, 1000);

  try {
    const response = await f.request('/api/users/login', {
      method: 'POST',
      ...binary(LoginRequestSchema, { key: new Uint8Array(16) }),
      headers: { 'User-Agent': 'Android' },
    });

    await decode(response, LoginResponseSchema);
  } finally {
    clearTimeout(keepAlive);
  }

  assert.equal(aborted, true);
  assert.deepEqual(readFileSync(metadata), before);
});

await test('F07 TrainingPeaks home refresh publishes zfiles and a failed refresh retains the previous library', async (t) => {
  const f = await mediumFixture(t);
  const browser = await mediumBrowser(f);
  const folder = resolve(f.config.storageDir, 'bridge');
  mkdirSync(folder);
  writeDurable(resolve(folder, 'first.zwo'), xml);
  const configured = await browser.form(`/trainingpeaks/${f.rider.username}/`, { bridge_folder: folder });
  assert.equal(configured.status, 200);
  const home = await browser.request(`/user/${f.rider.username}/`);
  assert.equal(home.status, 200);
  const first = await decode(await f.request('/api/zfiles/list?folder=customworkouts'), ZFilesProtoSchema);
  assert.equal(first.zfiles.length, 1);
  const id = first.zfiles[0]?.id;
  assert.ok(id);
  const download = await f.request(`/api/zfiles/${id}/download`);
  assert.equal(await download.text(), xml);
  const before = f.accounts.db.prepare('SELECT * FROM zfile').all();
  writeDurable(resolve(folder, 'first.zwo'), xml.replace('Medium Tempo', 'Changed'), true);
  writeDurable(resolve(folder, 'second.zwo'), '<broken>');
  const failed = await browser.request(`/user/${f.rider.username}/`);
  assert.equal(failed.status, 200);
  const unchanged = await f.request(`/api/zfiles/${id}/download`);
  assert.equal(await unchanged.text(), xml);
  assert.deepEqual(f.accounts.db.prepare('SELECT * FROM zfile').all(), before);
});

await test('F07 climb selection reaches and is consumed by the CDN portal schedule', async (t) => {
  const f = await mediumFixture(t);
  const browser = await mediumBrowser(f);
  const home = await browser.request(`/user/${f.rider.username}/`);
  assert.match(await home.text(), /<option value="10001">/);
  const selected = await browser.form('/start-zwift', { map: '6', climb: '10001' });
  assert.equal(selected.status, 302);
  const cdn = createCdn(f);
  const env = { incoming: { socket: { remoteAddress: '', remotePort: 12_345, remoteFamily: 'IPv4' } } };
  const portal = await cdn.request('/gameassets/PortalRoadSchedule_v1.xml', undefined, env);
  assert.equal(portal.status, 200);
  assert.match(await portal.text(), /appointment road="10001"/);
  assert.equal(f.world.climbOverrides.has(''), false);
  const map = await cdn.request('/gameassets/MapSchedule_v2.xml', undefined, env);
  assert.equal(map.status, 200);
  assert.match(await map.text(), /appointment map="6"/);
  assert.equal(f.world.mapOverrides.has(''), false);
});

for (const sport of [undefined, 'CYCLING', 'cycling', 'RUNNING', 'running', 'ROWING']) {
  await test(`F14 all planned-workout endpoints filter sport consistently: ${sport ?? 'omitted'}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 13, 12) });
    const f = await mediumFixture(t);
    const browser = await mediumBrowser(f);
    await browser.form(`/intervals/${f.rider.username}/`, { athlete_id: '123', api_key: 'medium-key' });
    t.mock.method(globalThis, 'fetch', (input: URL | string) =>
      Promise.resolve(
        String(input).endsWith('/download.zwo')
          ? new Response(xml)
          : Response.json([{ id: 42, start_date_local: `${day}T08:00:00` }]),
      ),
    );
    const synced = await browser.form(`/intervals/${f.rider.username}/sync`);
    assert.equal(synced.status, 200);
    const baseline = await f.request('/api/workout/schedule/list');
    const [workout] = schedules.parse(await baseline.json());
    assert.ok(workout);
    const query = sport === undefined ? '' : `?sport=${sport}`;
    const cycling = sport === undefined || sport.toUpperCase() === 'CYCLING';

    for (const [path, empty] of [
      ['/api/workout/schedule/list', []],
      ['/api/head-unit-bff/game-home', {}],
      ['/api/head-unit-bff/carousels/for-you', []],
    ] as const) {
      const response = await f.request(path + query);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
      const body = await response.json();

      if (cycling) assert.notDeepEqual(body, empty);
      else assert.deepEqual(body, empty);
      const other = await f.request(path + query, {}, f.other);
      assert.deepEqual(await other.json(), empty);
    }

    const detail = await f.request(`/api/workout/workouts/${workout.workoutId}${query}`);
    assert.equal(detail.status, cycling ? 200 : 404);
    const other = await f.request(`/api/workout/workouts/${workout.workoutId}${query}`, {}, f.other);
    assert.equal(other.status, 404);
  });
}
