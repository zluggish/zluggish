import { RuntimeContext } from '#src/context';
import { ActivitiesService } from '#src/services/activities.service';
import { DocumentsService } from '#src/services/documents.service';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { GhostSchema, PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { RideRecoveryService } from '#src/services/ride-recovery.service';
import { World, worldTime } from '#src/world/state';
import { binary, mediumFixture } from '#tests/medium/support';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { StateHistory } from '#src/world/state-history';
import { RideRecoveryRepository } from '#src/repositories/ride-recovery.repository';
import { Effect, Layer, Schema } from 'effect';

const sample = (id: bigint, index: number, courseId = 6) =>
  create(PlayerStateSchema, {
    id,
    roadTime: 1000 + index,
    worldTime: worldTime() + BigInt(index) * 3000n,
    f19: (courseId << 16) | 4,
    aux3: 1 << 8,
    distance: index * 30,
  });

const encoded = (index: number) => toBinary(PlayerStateSchema, sample(1n, index));

async function riding(t: Parameters<typeof mediumFixture>[0]) {
  const f = await mediumFixture(t);
  f.effects.runSync(RideRecoveryService.use((service) => service.start()));
  // The fixture disposes the runtime first: the close runs on the service itself.
  const recovery = f.effects.runSync(RideRecoveryService);
  t.after(() => Effect.runPromise(recovery.close()));
  const id = BigInt(f.rider.player_id);
  f.world.login(id, new Uint8Array(16));
  await f.effects.runSync(RideRecoveryService).recordings.idle();

  return { f, id, path: f.effects.runSync(RideRecoveryService).recordings.path(f.rider.player_id) };
}

function ride(world: World, id: bigint, from: number, to: number, courseId = 6) {
  for (let index = from; index < to; index++) {
    world.receive(id, sample(id, index, courseId));
  }
}

await test('checkpoints append only new samples; a cut last record is ignored', async (t) => {
  const { f, id, path } = await riding(t);
  ride(f.world, id, 0, 10);
  await f.effects.runPromise(RideRecoveryService.use((service) => service.checkpoint()));
  const first = await f.effects.runSync(RideRecoveryService).recordings.read(f.rider.player_id);
  assert.equal(first?.states.length, 10);
  await f.effects.runPromise(RideRecoveryService.use((service) => service.checkpoint()));
  ride(f.world, id, 10, 15);
  await f.effects.runPromise(RideRecoveryService.use((service) => service.checkpoint()));
  const recorded = await f.effects.runSync(RideRecoveryService).recordings.read(f.rider.player_id);
  assert.deepEqual(
    recorded?.states.map((state) => state.distance),
    Array.from({ length: 15 }, (_, index) => index * 30),
  );

  truncateSync(path, readFileSync(path).length - 3);
  const cut = await f.effects.runSync(RideRecoveryService).recordings.read(f.rider.player_id);
  assert.equal(cut?.states.length, 14);
});

await test('after a crash cuts the last record, the next process appends after the complete ones', async (t) => {
  const storage = mkdtempSync(resolve(tmpdir(), 'zluggish-recovery-'));
  t.after(() => rmSync(storage, { recursive: true, force: true }));
  const before = new RideRecoveryRepository(storage, 1_000_000);
  await before.append(1, [encoded(0), encoded(1)]);
  const path = before.path(1);
  truncateSync(path, readFileSync(path).length - 3);

  const after = new RideRecoveryRepository(storage, 1_000_000);
  await after.append(1, [encoded(2), encoded(3)]);
  await after.append(1, [encoded(4)]);
  const recorded = await after.read(1);
  assert.deepEqual(
    recorded?.states.map((state) => state.distance),
    [0, 2, 3, 4].map((index) => index * 30),
  );
});

await test('a failed checkpoint writes its samples at the next one', async (t) => {
  const { f, id } = await riding(t);
  const { recordings } = f.effects.runSync(RideRecoveryService);
  ride(f.world, id, 0, 5);
  await f.effects.runPromise(RideRecoveryService.use((service) => service.checkpoint()));
  ride(f.world, id, 5, 10);
  const failing = t.mock.method(recordings, 'append', () => Promise.reject(new Error('disk full')));
  await f.effects.runPromise(RideRecoveryService.use((service) => service.checkpoint()));
  assert.equal(failing.mock.callCount(), 1);
  failing.mock.restore();
  ride(f.world, id, 10, 12);
  await f.effects.runPromise(RideRecoveryService.use((service) => service.checkpoint()));
  const recorded = await recordings.read(f.rider.player_id);
  assert.deepEqual(
    recorded?.states.map((state) => state.distance),
    Array.from({ length: 12 }, (_, index) => index * 30),
  );
});

await test('a restarted server resumes a recent ride on the same course and its ghost keeps every sample', async (t) => {
  const { f, id } = await riding(t);
  f.settings.save(f.rider.player_id, { 'ghosts.enabled': true });
  ride(f.world, id, 0, 20);
  await f.effects.runPromise(RideRecoveryService.use((service) => service.close()));

  // The process stops: memory is gone. A new world resumes from the recording.
  const world = new World();

  const restarted = Effect.runSync(
    Effect.gen(function* () {
      return yield* RideRecoveryService;
    }).pipe(Effect.provide(RideRecoveryService.layer), Effect.provide(Layer.succeed(RuntimeContext, { ...f, world }))),
  );

  Effect.runSync(restarted.start());
  t.after(() => Effect.runPromise(restarted.close()));
  world.login(id, new Uint8Array(16));
  await restarted.recordings.idle();
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  ride(world, id, 20, 25);
  await Effect.runPromise(restarted.checkpoint());
  assert.equal(world.histories.get(id)?.length, 25);
  await Effect.runPromise(restarted.checkpoint());
  const recording = await restarted.recordings.read(f.rider.player_id);
  assert.equal(recording?.states.length, 25);

  const services = { ...f, world };

  const response = await f.request(`/api/profiles/${f.rider.player_id}/activities`, {
    method: 'POST',
    ...binary(ActivitySchema, { playerId: id, courseId: 6n, name: 'Recovered', startDate: new Date().toISOString() }),
  });

  const { id: activity } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(await response.json());
  f.world.histories.set(id, world.histories.get(id) ?? new StateHistory());
  services.effects.runSync(
    ActivitiesService.use((service) =>
      service.finalize(
        create(ActivitySchema, {
          id: BigInt(activity),
          playerId: id,
          courseId: 6n,
          name: 'Recovered',
          startDate: new Date().toISOString(),
          distanceInMeters: 3000,
        }),
      ),
    ),
  );
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
  const folder = resolve(f.profiles.folder(f.rider.player_id), 'ghosts', '6', '1');
  const ghost = fromBinary(GhostSchema, readFileSync(resolve(folder, readdirSync(folder)[0] ?? '')));
  assert.equal(ghost.states.length, 25);
});

await test('a recording on another course or past the resume window is discarded', async (t) => {
  const { f, id, path } = await riding(t);
  ride(f.world, id, 0, 5);
  await f.effects.runPromise(RideRecoveryService.use((service) => service.checkpoint()));
  f.world.login(id, new Uint8Array(16));
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  ride(f.world, id, 5, 6, 7);
  await f.effects.runPromise(RideRecoveryService.use((service) => service.checkpoint()));
  await f.effects.runSync(RideRecoveryService).recordings.idle();
  assert.equal(f.world.histories.get(id)?.length, 1, 'another course starts a new history');

  ride(f.world, id, 6, 9, 7);
  await f.effects.runPromise(RideRecoveryService.use((service) => service.checkpoint()));
  const old = (Date.now() - 16 * 60_000) / 1000;
  utimesSync(path, old, old);
  f.world.login(id, new Uint8Array(16));
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  await f.effects.runSync(RideRecoveryService).recordings.idle();
  assert.equal(existsSync(path), false);
});

await test('a connection end neither completes nor uploads a ride, and keeps the recording', async (t) => {
  const { f, id, path } = await riding(t);
  f.effects.runSync(DocumentsService.use((service) => service.put(f.rider.player_id, 'runalyze_token.txt', 'token')));
  ride(f.world, id, 0, 5);
  await f.effects.runPromise(RideRecoveryService.use((service) => service.checkpoint()));
  f.world.logout(id, 'inactivity_timeout');
  await f.effects.runSync(RideRecoveryService).recordings.idle();
  assert.ok(existsSync(path));
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM activity_completion').get()?.n, 0);
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM job').get()?.n, 0);

  f.world.logout(id, 'activity_finished');
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  assert.equal(existsSync(path), false);

  // The next checkpoint does not record the finished ride again.
  await f.effects.runPromise(RideRecoveryService.use((service) => service.checkpoint()));
  await f.effects.runSync(RideRecoveryService).recordings.idle();
  assert.equal(existsSync(path), false);
});
