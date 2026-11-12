import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runtimeFixture } from '#tests/support/runtime';
import { GoalSchema, GoalsSchema } from '#src/protocol/generated/goal_pb';
import { SegmentResultSchema, SegmentResultsSchema } from '#src/protocol/generated/segment-result_pb';
import { PrivateEventProtoSchema } from '#src/protocol/generated/events_pb';
import { PlayerStateSchema, UserBikeAction } from '#src/protocol/generated/udp-node-msgs_pb';
import { Workouts, workoutDetails } from '#src/domain/workouts/planned';
import { Simulation } from '#src/world/simulation';
import { Connections } from '#src/node/persistence/connections';
import { Trail } from '#src/world/geometry';
import { worldTime } from '#src/world/state';
import { writeDurable } from '#src/node/persistence/files';

await test('goals derive UTC period progress and results retain 64-bit segment IDs', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Progress Rider', '', true);

  const headers = {
    Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}`,
  };

  f.accounts.db
    .prepare('INSERT INTO activity (player_id,sport,start_date,end_date,distanceInMeters) VALUES (?,?,?,?,?)')
    .run(user.player_id, 0, new Date().toISOString(), new Date(Date.now() + 600_000).toISOString(), 12_345);

  const goal = create(GoalSchema, {
    playerId: BigInt(user.player_id),
    name: 'Weekly distance',
    type: 0,
    periodicity: 0,
    sport: 0,
    targetDistance: 20_000,
  });

  const saved = await f.app.request(`/api/profiles/${user.player_id}/goals`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/x-protobuf-lite' },
    body: toBinary(GoalSchema, goal),
  });

  assert.equal(saved.status, 200);
  assert.equal(fromBinary(GoalSchema, new Uint8Array(await saved.arrayBuffer())).actualDistance, 12_345);

  const goals = await f.app.request(`/api/profiles/${user.player_id}/goals`, {
    headers,
  });

  assert.equal(fromBinary(GoalsSchema, new Uint8Array(await goals.arrayBuffer())).goals.length, 1);

  const result = create(SegmentResultSchema, {
    playerId: BigInt(user.player_id),
    segmentId: 9_223_372_036_854_775_807n,
    firstName: 'P',
    lastName: 'Rider',
    elapsedMs: 123_456n,
  });

  const response = await f.app.request('/api/segment-results', {
    method: 'POST',
    headers,
    body: toBinary(SegmentResultSchema, result),
  });

  assert.equal(response.status, 200);

  const leaders = await f.app.request(`/live-segment-results-service/leaderboard/${result.segmentId}`);

  assert.equal(leaders.status, 200);

  const parsed = fromBinary(SegmentResultsSchema, new Uint8Array(await leaders.arrayBuffer()));

  assert.equal(parsed.segmentId, result.segmentId);
  assert.equal(parsed.segmentResults[0]?.elapsedMs, 123_456n);
});

await test('meetup invitations persist, protect ownership and return both protocol formats', async (t) => {
  const f = runtimeFixture(t);
  const owner = await f.accounts.create('Organizer', '', true);
  const invited = await f.accounts.create('Invitee', '');
  const outsider = await f.accounts.create('Outsider', '');

  const headersFor = (user: typeof owner) => ({
    Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}`,
  });

  const event = {
    culling: true,
    distanceInMeters: 10_000,
    durationInSeconds: 0,
    eventStart: new Date(Date.now() + 120_000).toISOString(),
    invitedProfileIds: [invited.player_id],
    laps: 1,
    routeId: 123,
    rubberbanding: true,
    showResults: false,
    sport: 'CYCLING',
    workoutHash: 0,
  };

  const created = await f.app.request('/api/private_event', {
    method: 'POST',
    headers: { ...headersFor(owner), 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });

  assert.equal(created.status, 201);
  const id = z.object({ id: z.number() }).parse(await created.json()).id;

  const detail = await f.app.request(`/api/private_event/${id}`, {
    headers: headersFor(invited),
  });

  const decoded = fromBinary(PrivateEventProtoSchema, new Uint8Array(await detail.arrayBuffer()));

  assert.equal(decoded.eventInvites.length, 2);

  const response1 = await f.app.request(`/api/private_event/${id}`, {
    method: 'DELETE',
    headers: headersFor(outsider),
  });

  assert.equal(response1.status, 403);

  const response2 = await f.app.request(`/api/private_event/${id}/accept`, {
    method: 'PUT',
    headers: headersFor(invited),
  });

  assert.equal(response2.status, 204);

  const feed = await f.app.request('/api/private_event/feed?start_date=0', {
    headers: { ...headersFor(invited), Accept: 'application/json' },
  });

  assert.equal(z.array(z.object({ inviteStatus: z.string() })).parse(await feed.json())[0]?.inviteStatus, 'ACCEPTED');
});

await test('workout ramps split at power boundaries and cached schedules retain stable UUIDs', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Workout Rider', '', true);

  const xml =
    '<workout_file><name>Tempo</name><sportType>bike</sportType><workout><Warmup Duration="600" PowerLow="0.5" PowerHigh="1.0"/><SteadyState Duration="300" Power="0.8"/></workout></workout_file>';

  const details = workoutDetails(xml);
  assert.equal(details?.duration, 900);
  assert.equal(
    details?.zonePercentages.reduce((a, b) => a + b, 0),
    100,
  );
  assert.deepEqual(details?.zonePercentages, [7, 27, 53, 13, 0, 0]);
  assert.throws(() => workoutDetails('<!DOCTYPE foo><workout_file/>'));
  const workouts = new Workouts(f);
  const id = '84e16aa6-2e13-4cc5-9bea-76595a66abe0';
  const file = workouts.file(id);
  assert.ok(file);
  writeDurable(file, xml);
  new Connections(f.accounts.storage).save(user.player_id, 'intervals', ['123', 'secret']);
  writeDurable(
    resolve(f.profiles.folder(user.player_id), 'intervals_icu_workout.json'),
    JSON.stringify({
      provider: 'intervals-icu',
      event_id: 42,
      workout_id: id,
      start_date_local: '2026-11-12T08:00:00',
    }),
  );
  const first = workouts.list(user.player_id, new Date(2026, 10, 12));
  assert.equal(first.length, 1);
  assert.equal(
    first[0]?.schedule.scheduleId,
    workouts.list(user.player_id, new Date(2026, 10, 12))[0]?.schedule.scheduleId,
  );
  assert.equal(workouts.list(user.player_id, new Date(2026, 10, 13)).length, 0);
});

await test('trail interpolation follows junctions, extrapolates altitude and resets teleports', () => {
  let now = 0;
  const trail = new Trail(() => now);

  const state = create(PlayerStateSchema, {
    id: 1n,
    f19: (6 << 16) | 4,
    roadTime: 1000,
    roadPosition: 10_200_000,
    x: 0,
    z: 0,
    speed: 36_000_000,
    worldTime: worldTime(),
  });

  trail.push(state);
  now = 1;
  state.x = 1000;
  state.yAltitude = 100;
  state.roadTime = 2000;
  trail.push(state);
  now = 2;
  state.x = 2000;
  state.yAltitude = 200;
  state.roadTime = 3000;
  trail.push(state);
  assert.equal(trail.ready(), true);
  assert.equal(trail.sample(5)?.state.x, 1500);
  assert.equal(trail.sample(-5)?.state.yAltitude, 250);
  now = 3;
  state.x = 30_000;
  trail.push(state);
  assert.equal(trail.resets, 1);
  assert.equal(trail.ready(), false);
});

await test('blob chat overrides survive reconstruction, gestures change mode, stale anchors disappear', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Blob Rider', '', true);
  let now = 100;
  const simulation = new Simulation(f, () => now);
  t.after(() => simulation.close());
  assert.equal(simulation.command(BigInt(user.player_id), 'blob 8'), 'Blob settings saved.');

  for (let i = 0; i < 5; i++) {
    now++;
    f.world.receive(
      BigInt(user.player_id),
      create(PlayerStateSchema, {
        id: BigInt(user.player_id),
        f19: (6 << 16) | 4,
        aux3: 1 << 8,
        roadTime: 1000 + i * 1000,
        roadPosition: 10_200_000,
        x: i * 1000,
        speed: 36_000_000,
        power: 200,
        worldTime: worldTime() + BigInt(i),
      }),
    );
  }

  simulation.tick();
  assert.equal(f.world.synthetic.size, 8);
  const payload = Buffer.alloc(16);
  payload.writeBigUInt64LE(BigInt(user.player_id));
  payload.writeUInt32LE(UserBikeAction.UBA_HAMMER, 8);
  assert.match(simulation.gesture(BigInt(user.player_id), payload) ?? '', /HAMMER/);
  assert.equal(simulation.blobs.get(BigInt(user.player_id))?.mode, 'hammer');
  assert.equal(f.settings.world(`blob:${user.player_id}`).riders, 8);
  now += 10;
  simulation.tick();
  assert.equal(f.world.synthetic.size, 0);
  const again = new Simulation(f, () => now);
  assert.equal(again.blobs.get(BigInt(user.player_id))?.riders.length, 8);
  assert.ok(existsSync(resolve(f.accounts.storage, 'settings.db')));
});

await test('game storage updates preserve other equipment signatures', async (t) => {
  const { UserStorageSchema } = await import('#src/protocol/generated/user_storage_pb');

  const f = runtimeFixture(t);
  const user = await f.accounts.create('Garage Rider', '', true);

  const headers = {
    Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}`,
  };

  const post = (attributes: Parameters<typeof create<typeof UserStorageSchema>>[1]) =>
    f.app.request('/api/player-profile/user-game-storage/attributes', {
      method: 'POST',
      headers,
      body: toBinary(UserStorageSchema, create(UserStorageSchema, attributes)),
    });

  const response3 = await post({
    attributes: [
      { bikeProgress: { signature: 'bike-a', level: 1 } },
      { bikeProgress: { signature: 'bike-b', level: 2 } },
    ],
  });

  assert.equal(response3.status, 202);

  const response4 = await post({
    attributes: [{ bikeProgress: { signature: 'bike-a', level: 3 } }],
  });

  assert.equal(response4.status, 202);

  const response = await f.app.request('/api/player-profile/user-game-storage/attributes?n=24', { headers });

  const storage = fromBinary(UserStorageSchema, new Uint8Array(await response.arrayBuffer()));

  assert.equal(storage.attributes.length, 2);
  assert.equal(storage.attributes.find((item) => item.bikeProgress?.signature === 'bike-b')?.bikeProgress?.level, 2);
  assert.equal(storage.attributes.find((item) => item.bikeProgress?.signature === 'bike-a')?.bikeProgress?.level, 3);
});
