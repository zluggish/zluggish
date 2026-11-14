import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { Trail } from '#src/world/geometry';
import { worldTime } from '#src/world/state';
import { create } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { test } from 'node:test';

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
