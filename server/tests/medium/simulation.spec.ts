import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import { GhostSchema, PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { AssetFiles } from '#src/repositories/files.repository';
import { worldTime } from '#src/world/state';
import { Simulation } from '#src/world/simulation';
import { runtimeFixture } from '#tests/support/runtime';
import { create, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

await test('simulation playback stops, resumes and removes deleted pacers on reload', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.UTC(2026, 10, 12) });
  const f = runtimeFixture(t);
  const folder = resolve(f.accounts.storage, 'robopacers/demo');
  new AssetFiles().writeDurable(
    resolve(folder, 'profile.bin'),
    toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 100n, firstName: 'Pacer' })),
  );
  new AssetFiles().writeDurable(
    resolve(folder, 'route.bin'),
    toBinary(
      GhostSchema,
      create(GhostSchema, {
        playerId: 100,
        states: [0, 1000, 2000].map((x) => create(PlayerStateSchema, { id: 100n, x, roadTime: x + 1 })),
      }),
    ),
  );
  const simulation = new Simulation(f, () => Date.now() / 1000);
  t.after(() => simulation.close());
  const first = f.world.synthetic.get(100n)?.x;
  assert.ok(first !== undefined);
  simulation.start();
  simulation.start();
  t.mock.timers.tick(1000);
  const moved = f.world.synthetic.get(100n)?.x;
  assert.notEqual(moved, first);
  simulation.close();
  t.mock.timers.tick(1000);
  assert.equal(f.world.synthetic.get(100n)?.x, moved);
  simulation.start();
  t.mock.timers.tick(1000);
  assert.notEqual(f.world.synthetic.get(100n)?.x, moved);
  rmSync(folder, { recursive: true });
  simulation.reload();
  assert.equal(f.world.synthetic.has(100n), false);
  assert.equal(f.profiles.synthetic.has(100n), false);
});

await test('ghost regroup before lazy loading preserves independent playback and loading states', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Ghost Rider', '', true);
  f.settings.save(rider.player_id, { 'ghosts.enabled': true });
  let now = 100;
  const simulation = new Simulation(f, () => now);
  const id = BigInt(rider.player_id);

  const state = create(PlayerStateSchema, {
    id,
    f19: (6 << 16) | 4,
    aux3: 1 << 8,
    roadTime: 1000,
    worldTime: worldTime(),
  });

  f.world.receive(id, state);
  simulation.regroup(id);
  assert.equal(simulation.ghosts.get(id)?.loading, 'waiting');
  assert.equal(simulation.ghosts.get(id)?.playback, 'playing');
  const file = resolve(f.profiles.folder(rider.player_id), 'ghosts/6/1/test.bin');
  new AssetFiles().writeDurable(
    file,
    toBinary(GhostSchema, create(GhostSchema, { playerId: rider.player_id, states: [state] })),
  );
  f.world.receive(id, { ...state, roadTime: 2000, worldTime: state.worldTime + 1n });
  assert.equal(simulation.ghosts.get(id)?.loading, 'loaded');
  now += 3;
  simulation.tick();
  const ghostId = id + 10_000_000n;
  assert.equal(f.world.personal.get(id)?.has(ghostId), true);
  now += 3;
  simulation.tick();
  assert.equal(f.world.personal.get(id)?.has(ghostId), false);
  f.world.receive(id, { ...state, roadTime: 500, worldTime: state.worldTime + 2n });
  simulation.regroup(id);
  now += 3;
  simulation.tick();
  assert.equal(f.world.personal.get(id)?.has(ghostId), true);
  f.world.logout(id);
  assert.equal(simulation.ghosts.has(id), false);
  assert.equal(f.world.personal.has(id), false);
});
