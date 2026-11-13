import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger } from '#src/logging';
import { World, worldTime } from '#src/world/state';
import { create } from '@bufbuild/protobuf';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { Lifecycle } from '#src/world/lifecycle';

await test('deduplicate transitions, throttle progress, and release state', () => {
  let now = 0;
  const lines: string[] = [];

  const tracker = new Lifecycle(
    createLogger({
      format: 'json',
      sink: (line) => {
        lines.push(line);
      },
    }),
    60,
    () => now,
  );

  tracker.connected(42n);
  tracker.connected(42n);
  tracker.companion(42n);
  tracker.companion(42n);

  for (let i = 0; i < 100; i++) tracker.receive(42n, i, 6, 1n, 0);
  now = 60_000;
  tracker.receive(42n, 500, 6, 1n, 0);
  tracker.receive(43n, 0, 6, 1n, 0);
  tracker.end(42n, 'logout');
  tracker.end(42n, 'inactivity_timeout');
  tracker.close();
  const events = lines.map((line) => JSON.parse(line).event);
  assert.equal(events.filter((event) => event === 'game.connected').length, 1);
  assert.equal(events.filter((event) => event === 'companion.registered').length, 1);
  assert.equal(events.filter((event) => event === 'ride.started').length, 2);
  assert.equal(events.filter((event) => event === 'ride.progress').length, 1);
  assert.equal(events.filter((event) => event === 'ride.ended').length, 2);
  assert.equal(tracker.rides.size, 0);
});

await test('disabled progress still cleans up; invalid packet diagnostics are bounded', () => {
  let now = 0;
  const lines: string[] = [];

  const tracker = new Lifecycle(
    createLogger({
      level: 'VERBOSE',
      sink: (line) => {
        lines.push(line);
      },
    }),
    0,
    () => now,
  );

  tracker.receive(1n, 0, 6, 0n, 0);
  now = 600_000;
  tracker.receive(1n, 50, 6, 0n, 0);

  for (let i = 0; i < 1000; i++) tracker.diagnostic('network.udp_rejected', 'Invalid packet');
  assert.equal(lines.length, 2);
  tracker.end(1n, 'inactivity_timeout');
  assert.equal(tracker.rides.size, 0);
  assert.doesNotMatch(lines.join('\n'), /ride.progress/);
});

await test('world acceptance gates lifecycle events for stale, invalid and out-of-order state', () => {
  const lines: string[] = [];
  const world = new World();
  world.lifecycle.log = createLogger({
    format: 'json',
    sink: (line) => {
      lines.push(line);
    },
  });
  const state = create(PlayerStateSchema, { id: 1n, roadTime: 1, worldTime: worldTime(), distance: 10 });
  world.receive(1n, { ...state, worldTime: state.worldTime - 60_000n });
  assert.equal(lines.length, 0);
  assert.throws(() => world.receive(2n, state));
  world.receive(1n, state);
  world.receive(1n, { ...state, worldTime: state.worldTime - 1n });
  assert.equal(lines.length, 1);
  world.logout(1n);
  world.logout(1n);
  assert.equal(lines.length, 2);
  assert.equal(world.lifecycle.rides.size, 0);
});

await test('inactive handshakes expire without fabricating a ride', () => {
  let now = 0;
  const lines: string[] = [];

  const tracker = new Lifecycle(
    createLogger({
      sink: (line) => {
        lines.push(line);
      },
    }),
    60,
    () => now,
  );

  tracker.connected(1n);
  now = 30_000;
  tracker.prune();
  tracker.prune();
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /inactivity_timeout/);
  assert.doesNotMatch(lines.join('\n'), /ride.started|ride.ended/);
});
