import { WorkoutsService, workoutDetails } from '#src/services/workout.service';
import { Connections } from '#src/repositories/connections.repository';
import { writeDurable } from '#src/repositories/files.repository';
import { PrivateEventProtoSchema } from '#src/protocol/generated/events_pb';
import { PlayerStateSchema, UserBikeAction } from '#src/protocol/generated/udp-node-msgs_pb';
import { Simulation } from '#src/world/simulation';
import { worldTime } from '#src/world/state';
import { runtimeFixture } from '#tests/support/runtime';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';

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
  const workouts = new WorkoutsService(f);
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
      { bikeProgress: { signature: 'bike-a', level: 1 }, gameSettings: { screenShakeScale: 1 } },
      { bikeProgress: { signature: 'bike-b', level: 2 } },
    ],
  });

  assert.equal(response3.status, 202);

  const response4 = await post({
    attributes: [{ bikeProgress: { signature: 'bike-a', level: 3 } }],
  });

  assert.equal(response4.status, 202);

  const response = await f.app.request('/api/player-profile/user-game-storage/attributes?n=24&n=22', { headers });

  const storage = fromBinary(UserStorageSchema, new Uint8Array(await response.arrayBuffer()));

  assert.equal(storage.attributes.length, 3);
  assert.equal(storage.attributes.find((item) => item.gameSettings)?.gameSettings?.screenShakeScale, 1);
  assert.equal(storage.attributes.find((item) => item.bikeProgress?.signature === 'bike-b')?.bikeProgress?.level, 2);
  assert.equal(storage.attributes.find((item) => item.bikeProgress?.signature === 'bike-a')?.bikeProgress?.level, 3);
});
