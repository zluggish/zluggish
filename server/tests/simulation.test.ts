import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { create, toBinary } from '@bufbuild/protobuf';
import { runtimeFixture } from '#tests/support/runtime';
import { Simulation } from '#src/world/simulation';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import { GhostSchema, PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { writeDurable } from '#src/node/persistence/files';

await test('simulation playback stops, resumes and removes deleted pacers on reload', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.UTC(2026, 10, 12) });
  const f = runtimeFixture(t);
  const folder = resolve(f.accounts.storage, 'robopacers/demo');
  writeDurable(
    resolve(folder, 'profile.bin'),
    toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 100n, firstName: 'Pacer' })),
  );
  writeDurable(
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
