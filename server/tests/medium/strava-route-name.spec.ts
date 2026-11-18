import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { RouteResultSaveRequestSchema } from '#src/protocol/generated/route-result_pb';
import { UploadsService } from '#src/services/uploads.service';
import { binary, mediumFixture } from '#tests/medium/support';
import { create } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';

const fit = readFileSync(new URL('../fixtures/ride.fit', import.meta.url));

/** Cote de Pike. */
const ROUTE = 10_003;

const STRAVA_ACTIVITY = 9_000_000_001;

const editPage = `<input name="authenticity_token" value="token"> var athleteId = 5;
<form class="edit_activity"><input name="activity[name]" value="old"></form>`;

type Fixture = Awaited<ReturnType<typeof mediumFixture>>;

async function ridden(f: Fixture) {
  const data = {
    playerId: BigInt(f.rider.player_id),
    courseId: 6n,
    name: 'Zwift - Endurance',
    startDate: new Date().toISOString(),
    distanceInMeters: 3000,
    fitFilename: 'ride.fit',
    fit,
  };

  const response = await f.request(`/api/profiles/${f.rider.player_id}/activities`, {
    method: 'POST',
    ...binary(ActivitySchema, data),
  });

  const { id } = z.object({ id: z.number() }).parse(await response.json());
  f.services.activities.finalize(create(ActivitySchema, { ...data, id: BigInt(id) }));

  return { id, activity: create(ActivitySchema, { ...data, id: BigInt(id) }) };
}

const routeResult = (f: Fixture, activity: number, hash = ROUTE) =>
  f.accounts.db
    .prepare('INSERT INTO route_result(player_id,route_hash,activity_id) VALUES (?,?,?)')
    .run(f.rider.player_id, hash, activity);

/** Strava as far as the free upload and the edit of a title go: the titles saved are collected. */
function strava(t: TestContext) {
  const titles: string[] = [];

  t.mock.method(globalThis, 'fetch', (input: string | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.endsWith('/upload/select'))
      return Promise.resolve(new Response('Upload and Sync Your Activities <meta name="csrf-token" content="token">'));

    if (url.endsWith('/upload/files')) return Promise.resolve(Response.json([{ workflow: 'uploaded', id: 77 }]));

    if (url.includes('/upload/progress.json'))
      return Promise.resolve(Response.json([{ workflow: 'success', id: 77, activity: { id: STRAVA_ACTIVITY } }]));

    if (url.endsWith(`/activities/${STRAVA_ACTIVITY}/edit`)) return Promise.resolve(new Response(editPage));

    if (url.endsWith(`/activities/${STRAVA_ACTIVITY}`) && init?.method === 'POST') {
      titles.push(String(new URLSearchParams(String(init.body)).get('activity[name]')));

      return Promise.resolve(new Response(null, { status: 200 }));
    }

    return Promise.reject(new Error(`unexpected request: ${url}`));
  });

  return titles;
}

const stravaActivityOf = (f: Fixture, id: number) =>
  z
    .object({ id: z.number().nullable() })
    .parse(f.accounts.db.prepare('SELECT strava_activity_id AS id FROM activity WHERE id = ?').get(id)).id;

await test('a route that the game reported before the upload is in the Strava title, and the activity id is kept', async (t) => {
  const f = await mediumFixture(t);
  const { id, activity } = await ridden(f);
  routeResult(f, id);
  f.services.documents.put(f.rider.player_id, 'strava4_session.txt', 'cookie');
  const titles = strava(t);

  await new UploadsService(f).freeStrava(f.rider.player_id, activity, []);

  assert.deepEqual(titles, ['Zwift - Endurance - Cote de Pike']);
  assert.equal(stravaActivityOf(f, id), STRAVA_ACTIVITY, 'an id beyond 32 bits is kept');
});

await test('a route that arrives after the upload is added to the Strava title then', async (t) => {
  const f = await mediumFixture(t);
  const { id, activity } = await ridden(f);
  f.services.documents.put(f.rider.player_id, 'strava4_session.txt', 'cookie');
  const titles = strava(t);
  const uploads = new UploadsService(f);

  await uploads.freeStrava(f.rider.player_id, activity, []);
  assert.deepEqual(titles, ['Zwift - Endurance'], 'the route was not known at the upload');
  assert.equal(await uploads.nameStravaWithRoute(f.rider.player_id, id), false, 'nothing to add yet');

  routeResult(f, id);
  assert.equal(await uploads.nameStravaWithRoute(f.rider.player_id, id), true);
  assert.deepEqual(titles, ['Zwift - Endurance', 'Zwift - Endurance - Cote de Pike']);
});

await test('the title is left alone without a Strava session, an activity on Strava, or a known route', async (t) => {
  const f = await mediumFixture(t);
  const { id } = await ridden(f);
  strava(t);
  const uploads = new UploadsService(f);
  routeResult(f, id);

  assert.equal(await uploads.nameStravaWithRoute(f.rider.player_id, id), false, 'no session');

  f.services.documents.put(f.rider.player_id, 'strava4_session.txt', 'cookie');
  assert.equal(await uploads.nameStravaWithRoute(f.rider.player_id, id), false, 'not on Strava');

  f.accounts.db.prepare('UPDATE activity SET strava_activity_id = ? WHERE id = ?').run(STRAVA_ACTIVITY, id);
  routeResult(f, id, 1);
  assert.equal(await uploads.nameStravaWithRoute(f.rider.player_id, id), false, 'the latest route has no name');

  assert.equal(await uploads.nameStravaWithRoute(f.rider.player_id, id + 1000), false, 'unknown activity');
});

await test('a route result posted by the game asks for the title of its activity to be changed', async (t) => {
  const f = await mediumFixture(t);
  const { id } = await ridden(f);
  const named = t.mock.method(f.services.uploads, 'nameStravaWithRoute', () => Promise.resolve(true));

  const response = await f.request('/api/route-results', {
    method: 'POST',
    ...binary(RouteResultSaveRequestSchema, { routeHash: BigInt(ROUTE), activityId: BigInt(id), elapsedMs: 1000n }),
  });

  assert.equal(response.status, 202);
  assert.deepEqual(
    named.mock.calls.map((call) => call.arguments),
    [[f.rider.player_id, id]],
  );

  await f.request('/api/route-results', {
    method: 'POST',
    ...binary(RouteResultSaveRequestSchema, { routeHash: BigInt(ROUTE), elapsedMs: 1000n }),
  });
  assert.equal(named.mock.callCount(), 1, 'a result without an activity asks for nothing');
});
