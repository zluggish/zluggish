import { Effect } from 'effect';
import { blobRiderFigures, STAND_RATIO } from '#src/world/pro-build';
import { RideRecoveryService } from '#src/services/ride-recovery.service';
import { validateConfig } from '#src/config/index';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import { GhostSchema, PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { AssetFiles } from '#src/repositories/files.repository';
import { worldTime } from '#src/world/state';
import { Simulation } from '#src/world/simulation';
import { runtimeFixture } from '#tests/support/runtime';
import { create, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import fs, { rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';

await test('simulation playback stops, resumes and removes deleted pacers on reload', async (t) => {
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
  await simulation.ready;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const first = f.world.synthetic.get(100n)?.x;
  assert.ok(first !== undefined);
  simulation.start();
  simulation.start();
  t.mock.timers.tick(1000);
  await setImmediate();
  const moved = f.world.synthetic.get(100n)?.x;
  assert.notEqual(moved, first);
  await simulation.close();
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(f.world.synthetic.get(100n)?.x, moved);
  simulation.start();
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.notEqual(f.world.synthetic.get(100n)?.x, moved);
  rmSync(folder, { recursive: true });
  await simulation.reload();
  assert.equal(f.world.synthetic.has(100n), false);
  assert.equal(f.profiles.synthetic.has(100n), false);
});

await test('simulation ticks recover from failures and stop until restarted', async (t) => {
  const f = runtimeFixture(t);
  const simulation = new Simulation(f);
  t.after(() => simulation.close());
  await simulation.ready;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const failure = new Error('tick failed');

  const tick = t.mock.method(simulation, 'tick', () => {
    if (tick.mock.callCount() === 0) {
      throw failure;
    }
  });

  const log = t.mock.method(f.world.lifecycle.log, 'error', () => {});

  const advance = async (milliseconds: number) => {
    t.mock.timers.tick(milliseconds);
    await setImmediate();
  };

  simulation.start();
  simulation.start();
  await advance(499);
  assert.equal(tick.mock.callCount(), 0);
  await advance(1);
  assert.equal(tick.mock.callCount(), 1);
  assert.equal(log.mock.callCount(), 1);
  assert.deepEqual(log.mock.calls[0]?.arguments, [
    'simulation.tick_failed',
    'Simulation tick failed',
    { error: failure },
  ]);
  await advance(500);
  assert.equal(tick.mock.callCount(), 2);
  await Promise.all([simulation.close(), simulation.close()]);
  await advance(2000);
  assert.equal(tick.mock.callCount(), 2);
  assert.equal(log.mock.callCount(), 1, 'stopping the loop is not a tick failure');
  simulation.start();
  await advance(499);
  assert.equal(tick.mock.callCount(), 2);
  await advance(1);
  assert.equal(tick.mock.callCount(), 3);
});

await test('ghost regroup before lazy loading preserves independent playback and loading states', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Ghost Rider', 'test-password');
  f.settings.save(rider.player_id, { 'ghosts.enabled': true });
  let now = 100;
  const simulation = new Simulation(f, () => now);
  t.after(() => simulation.close());
  await simulation.ready;
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
  assert.equal(simulation.ghosts.get(id)?.loading, 'loading');
  await simulation.idle();
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

await test('riding, ghost and bookmark loads, blobs, recovery and logout make no synchronous file calls', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Async Rider', 'test-password');
  f.settings.save(rider.player_id, { 'ghosts.enabled': true });
  const id = BigInt(rider.player_id);

  const state = (index: number) =>
    create(PlayerStateSchema, {
      id,
      f19: (6 << 16) | 4,
      aux3: 1 << 8,
      roadTime: 1000 + index,
      worldTime: worldTime() + BigInt(index) * 3000n,
    });

  new AssetFiles().writeDurable(
    resolve(f.profiles.folder(rider.player_id), 'ghosts/6/1/old.bin'),
    toBinary(GhostSchema, create(GhostSchema, { playerId: rider.player_id, states: [state(0), state(1)] })),
  );
  let now = 100;
  const simulation = new Simulation(f, () => now);
  t.after(() => simulation.close());
  await simulation.ready;
  f.effects.runSync(RideRecoveryService.use((service) => service.start()));
  // The fixture disposes the runtime first: the close runs on the service itself.
  const recovery = f.effects.runSync(RideRecoveryService);
  t.after(() => Effect.runPromise(recovery.close()));

  // From here on every synchronous file call throws and is recorded.
  const calls: Array<string> = [];

  const names = [
    'readFileSync',
    'readdirSync',
    'existsSync',
    'statSync',
    'lstatSync',
    'openSync',
    'writeFileSync',
    'appendFileSync',
    'fsyncSync',
    'renameSync',
    'mkdirSync',
    'rmSync',
    'unlinkSync',
    'linkSync',
    'copyFileSync',
  ] as const;

  const mocks = names.map((name) =>
    t.mock.method(fs, name, () => {
      calls.push(name);
      throw new Error(`${name} on the riding path`);
    }),
  );

  syncBuiltinESMExports();

  try {
    f.world.login(id, new Uint8Array(16));

    for (let index = 0; index < 6; index++) {
      now++;
      f.world.receive(id, state(index));
      simulation.tick();
    }

    assert.equal(simulation.command(id, 'blob 4'), 'Blob settings saved.');
    simulation.command(id, 'bookmark Home');
    await simulation.loadBookmarks(id);
    await f.effects.runPromise(RideRecoveryService.use((service) => service.checkpoint()));
    await simulation.idle();
    f.world.logout(id);
    await simulation.idle();
    await f.effects.runSync(RideRecoveryService).recordings.idle();
  } finally {
    for (const mock of mocks) {
      mock.mock.restore();
    }
    syncBuiltinESMExports();
  }

  assert.deepEqual(calls, []);
  assert.equal(simulation.ghosts.has(id), false);
  assert.equal(simulation.bookmarks.get(id)?.size, 2, 'the command bookmark and the last ride bookmark');
});

await test('synthetic riders carry an FTP: pacers 400, bots and blobs from their owner, pelotons from their power', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Owner Rider', 'test-password');
  const owner = f.profiles.get(rider.player_id);
  owner.ftp = 250;
  owner.weightInGrams = 70_000;
  owner.privacyBits |= 4n;
  f.profiles.save(rider.player_id, owner);

  const pacer = resolve(f.accounts.storage, 'robopacers/demo');
  new AssetFiles().writeDurable(
    resolve(pacer, 'profile.bin'),
    toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 100n, weightInGrams: 80_000 })),
  );
  new AssetFiles().writeDurable(
    resolve(pacer, 'route.bin'),
    toBinary(
      GhostSchema,
      create(GhostSchema, {
        playerId: 100,
        states: [0, 1000, 2000].map((x) => create(PlayerStateSchema, { id: 100n, x, roadTime: x + 1, power: 240 })),
      }),
    ),
  );

  const ghost = toBinary(
    GhostSchema,
    create(GhostSchema, { playerId: 1, states: [create(PlayerStateSchema, { id: 1n, roadTime: 1 })] }),
  );

  new AssetFiles().writeDurable(resolve(f.profiles.folder(rider.player_id), 'ghosts/6/1/a.bin'), ghost);
  // A folder without an account falls back to the defaults.
  new AssetFiles().writeDurable(resolve(f.accounts.storage, '999999', 'ghosts/6/1/b.bin'), ghost);

  const runtime = {
    ...f,
    config: validateConfig({
      storageDir: f.config.storageDir,
      bots: { enabled: true },
      pelotons: [{ id: 'demo', pacer: 100, bots: 3 }],
      soloBlob: { enabled: true, playerId: rider.player_id, riders: 3 },
    }),
  };

  const simulation = new Simulation(runtime, () => 100);
  t.after(() => simulation.close());
  await simulation.ready;

  assert.equal(simulation.replays.get(100n)?.profile.ftp, 400);

  const bots = simulation.replays
    .values()
    .filter((replay) => !replay.pacer)
    .map((replay) => f.profiles.get(Number(replay.profile.id)))
    .toArray()
    .sort((a, b) => a.ftp - b.ftp);

  assert.deepEqual(
    bots.map((bot) => bot.ftp),
    [250, 300],
  );
  assert.equal(bots[0]?.weightInGrams, 70_000);
  const orphan = bots[1];
  assert.ok(orphan);
  assert.equal(orphan.weightInGrams, simulation.replays.get(orphan.id)?.profile.weightInGrams);

  const peloton = simulation.pelotons.get('demo');
  assert.ok(peloton);
  assert.equal(peloton.riders.length, 3);

  for (const bot of peloton.riders) {
    assert.ok(bot.profile.ftp > 0);
    assert.equal(bot.profile.ftp, Math.trunc(bot.ftp));
  }

  const blob = simulation.blobs.get(BigInt(rider.player_id));
  assert.ok(blob);
  assert.equal(blob.riders.length, 3);

  // Blob riders ride at the owner's W/kg scaled by their strength and stand up past a multiple of the owner's FTP.
  for (const bot of blob.riders) {
    const traits = simulation.pool.traitsOf(bot.profile.id);
    const figures = blobRiderFigures(
      { ftp: 250, weightKg: 70 },
      { weightKg: bot.profile.weightInGrams / 1000, ...traits },
    );
    assert.equal(bot.profile.ftp, figures.ftp);
    assert.equal(bot.powerScale, figures.powerScale);
    assert.ok(bot.profile.ftp > 250);
    assert.ok(Math.abs((2 * bot.profile.ftp) / bot.powerScale / 250 - STAND_RATIO[traits.specialty]) < 0.01);
  }
});

await test('replay bot weights follow changes to the owner’s weight privacy', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Owner Rider', 'test-password');
  const owner = f.profiles.get(rider.player_id);
  owner.weightInGrams = 90_000;
  owner.privacyBits |= 4n;
  f.profiles.save(rider.player_id, owner);

  new AssetFiles().writeDurable(
    resolve(f.profiles.folder(rider.player_id), 'ghosts/6/1/a.bin'),
    toBinary(
      GhostSchema,
      create(GhostSchema, { playerId: 1, states: [create(PlayerStateSchema, { id: 1n, roadTime: 1 })] }),
    ),
  );

  const simulation = new Simulation(
    { ...f, config: validateConfig({ storageDir: f.config.storageDir, bots: { enabled: true } }) },
    () => 100,
  );

  t.after(() => simulation.close());
  await simulation.ready;

  const bot = simulation.replays.values().find((replay) => !replay.pacer);
  assert.ok(bot);
  const botId = Number(bot.profile.id);
  const fallback = bot.profile.weightInGrams;
  assert.ok(fallback >= 62_000 && fallback <= 86_000);
  assert.equal(f.profiles.get(botId).weightInGrams, 90_000);

  owner.privacyBits &= ~4n;
  f.profiles.save(rider.player_id, owner);

  const hidden = f.profiles.get(botId);
  assert.equal(hidden.weightInGrams, fallback);
  assert.equal(hidden.privacyBits & 4n, 4n);

  owner.weightInGrams = 95_000;
  owner.privacyBits |= 4n;
  f.profiles.save(rider.player_id, owner);
  assert.equal(f.profiles.get(botId).weightInGrams, 95_000);
});

await test('.blob keeps four slots and refuses a fifth without saving it', async (t) => {
  const f = runtimeFixture(t);
  const riders = await Promise.all(
    ['Rider One', 'Rider Two', 'Rider Three', 'Rider Four', 'Rider Five'].map((name) =>
      f.accounts.create(name, 'test-password'),
    ),
  );
  const ids = riders.map((rider) => BigInt(rider.player_id));
  const simulation = new Simulation(f, () => 100);
  t.after(() => simulation.close());
  await simulation.ready;

  for (const id of ids.slice(0, 4)) {
    assert.equal(simulation.command(id, 'blob 6'), 'Blob settings saved.');
  }
  assert.equal(simulation.blobs.size, 4);
  assert.equal(
    new Set(simulation.blobs.values().map((blob) => blob.index)).size,
    4,
    'the four blobs have distinct slot indexes',
  );

  const fifth = ids[4]!;
  assert.equal(
    simulation.command(fifth, 'blob 6'),
    'All four blob slots are taken. Another rider has to stop theirs with .blob off first.',
  );
  assert.equal(simulation.blobs.size, 4);
  assert.notEqual(f.settings.world(`blob:${fifth}`).enabled, true);

  f.settings.saveWorld(`blob:${fifth}`, { enabled: true, riders: 6 });
  await simulation.reload();
  assert.equal(simulation.blobs.size, 4);
  for (const id of ids.slice(0, 4)) {
    assert.ok(simulation.blobs.has(id));
  }

  assert.equal(simulation.command(ids[0]!, 'blob off'), 'Blob off.');
  assert.equal(simulation.command(fifth, 'blob 6'), 'Blob settings saved.');
  assert.ok(simulation.blobs.has(fifth));
});
