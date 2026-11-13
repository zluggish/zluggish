import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { create, toBinary } from '@bufbuild/protobuf';
import { Encoder, Profile, type FileIdMesg, type RecordMesg } from '@garmin/fitsdk';
import { mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { mediumFixture, mediumBrowser, binary, decode } from '#tests/medium/support';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { PlayerProfileSchema, StreaksSchema } from '#src/protocol/generated/profile_pb';
import { Completions } from '#src/repositories/completion.repository';
import { advancedStreak, streaksFor } from '#src/repositories/streak.repository';
import { ProfileImports } from '#src/repositories/profile-import.repository';
import { writeDurable } from '#src/repositories/files.repository';
import { activityChart } from '#src/repositories/fit.repository';
import { Simulation } from '#src/world/simulation';
import { GhostSchema, PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { validateConfig } from '#src/config/index';
import { ActivityUploads } from '#src/repositories/uploads.repository';
import { Accounts } from '#src/repositories/accounts.repository';
import { configureLogging, log } from '#src/logging';

await test('deleting a queued activity while another upload is sending prevents its later delivery', async (t) => {
  const f = await mediumFixture(t);
  writeDurable(resolve(f.profiles.folder(f.rider.player_id), 'runalyze_token.txt'), 'test');
  const ids: number[] = [];

  const data = {
    playerId: BigInt(f.rider.player_id),
    courseId: 6n,
    name: 'Queued',
    startDate: new Date().toISOString(),
    distanceInMeters: 3000,
    fitFilename: 'ride.fit',
    fit: readFileSync(new URL('../fixtures/ride.fit', import.meta.url)),
  };

  for (let i = 0; i < 2; i++) {
    const response = await f.request(`/api/profiles/${f.rider.player_id}/activities`, {
      method: 'POST',
      ...binary(ActivitySchema, data),
    });

    const { id } = z.object({ id: z.number() }).parse(await response.json());
    f.services.activities.finalize(create(ActivitySchema, { ...data, id: BigInt(id) }));
    ids.push(id);
  }

  const delivery = new EventEmitter();
  const released = once(delivery, 'release');

  const uploads = t.mock.method(globalThis, 'fetch', async () => {
    await released;

    return new Response(null, { status: 200 });
  });

  const draining = f.services.uploads.drain();
  assert.equal(uploads.mock.callCount(), 1);
  const deleted = await f.request(`/api/profiles/${f.rider.player_id}/activities/${ids[1]}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  delivery.emit('release');
  await draining;
  assert.equal(uploads.mock.callCount(), 1);
  assert.deepEqual(f.services.uploads.status(f.rider.player_id), [
    { activity_id: ids[0], provider: 'runalyze', state: 'sent' },
  ]);
});

await test('a failed completion commit is recovered before the rider saves another activity', async (t) => {
  const f = await mediumFixture(t);
  const base = `/api/profiles/${f.rider.player_id}/activities`;

  const data = {
    playerId: BigInt(f.rider.player_id),
    courseId: 6n,
    name: 'Before failure',
    startDate: new Date().toISOString(),
    distanceInMeters: 3000,
    fitFilename: 'ride.fit',
    fit: readFileSync(new URL('../fixtures/ride.fit', import.meta.url)),
  };

  const first = await f.request(base, { method: 'POST', ...binary(ActivitySchema, data) });
  const { id } = z.object({ id: z.number() }).parse(await first.json());
  f.accounts.db.exec(`CREATE TRIGGER fail_completion BEFORE UPDATE OF done ON activity_completion
    BEGIN SELECT RAISE(ABORT, 'injected completion failure'); END`);

  const failed = await f.request(`${base}/${id}?upload-to-strava=true`, {
    method: 'PUT',
    ...binary(ActivitySchema, { ...data, name: 'Final name' }),
  });

  assert.equal(failed.status, 500);
  assert.equal(f.accounts.db.prepare('SELECT name FROM activity WHERE id=?').get(id)?.name, 'Before failure');
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM power_curve').get()?.n, 0);
  f.accounts.db.exec('DROP TRIGGER fail_completion');
  const second = await f.request(base, { method: 'POST', ...binary(ActivitySchema, data) });
  const next = z.object({ id: z.number() }).parse(await second.json());

  const saved = await f.request(`${base}/${next.id}?upload-to-strava=true`, {
    method: 'PUT',
    ...binary(ActivitySchema, data),
  });

  assert.equal(saved.status, 200);
  f.services.activities.recover();
  const streaks = await decode(await f.request('/api/fitness/streaks'), StreaksSchema);
  assert.equal(streaks.curStreakDistance, 6000);
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM power_curve').get()?.n, 2);
  assert.equal(f.accounts.db.prepare('SELECT name FROM activity WHERE id=?').get(id)?.name, 'Final name');
});

await test('reopened upload queues require explicit owner retries for interrupted sends and honor disconnection', async (t) => {
  const f = await mediumFixture(t);
  const token = resolve(f.profiles.folder(f.rider.player_id), 'runalyze_token.txt');
  writeDurable(token, 'test');

  const data = {
    playerId: BigInt(f.rider.player_id),
    courseId: 6n,
    name: 'Interrupted',
    startDate: new Date().toISOString(),
    distanceInMeters: 3000,
    fitFilename: 'ride.fit',
    fit: readFileSync(new URL('../fixtures/ride.fit', import.meta.url)),
  };

  const response = await f.request(`/api/profiles/${f.rider.player_id}/activities`, {
    method: 'POST',
    ...binary(ActivitySchema, data),
  });

  const { id } = z.object({ id: z.number() }).parse(await response.json());
  f.services.activities.finalize(create(ActivitySchema, { ...data, id: BigInt(id) }));
  f.accounts.db.exec("UPDATE activity_upload SET state='sending'");
  f.accounts.close();
  const reopened = new Accounts(f.accounts.storage);
  const queue = new ActivityUploads({ ...f, accounts: reopened });
  t.after(async () => {
    await queue.close();
    reopened.close();
  });
  queue.start();
  await queue.drain();
  assert.equal(queue.status(f.rider.player_id)[0]?.state, 'failed');
  await queue.retry(f.other.player_id);
  assert.equal(queue.status(f.rider.player_id)[0]?.state, 'failed');
  assert.deepEqual(queue.status(f.other.player_id), []);
  unlinkSync(token);
  await queue.retry(f.rider.player_id);
  assert.equal(queue.status(f.rider.player_id)[0]?.state, 'cancelled');
});

await test('configured logging level controls request logging and application diagnostics', async (t) => {
  const f = await mediumFixture(t);
  const info = t.mock.method(console, 'log', () => {});
  const warning = t.mock.method(console, 'warn', () => {});
  const error = t.mock.method(console, 'error', () => {});
  t.after(() => configureLogging('INFO'));
  configureLogging('ERROR');
  const response = await f.request('/health');
  assert.equal(response.status, 200);
  log.warn('suppressed');
  log.error('visible');
  assert.equal(info.mock.callCount(), 0);
  assert.equal(warning.mock.callCount(), 0);
  assert.equal(error.mock.callCount(), 1);
  configureLogging('INFO');
  await f.request('/health');
  assert.ok(info.mock.callCount() > 0);
});

await test('charts retain running records with no power and intermittent sensor dropouts', async (t) => {
  const f = await mediumFixture(t);
  const encoder = new Encoder();

  const records: RecordMesg[] = [
    { timestamp: 1_000_000, distance: 0, speed: 3, heartRate: 120 },
    { timestamp: 1_000_001, distance: 3, speed: 3 },
    { timestamp: 1_000_002, distance: 6, speed: 3, heartRate: 130 },
  ];

  for (const record of records) encoder.onMesg(z.number().parse(Profile.MesgNum.RECORD), record);
  const chart = f.services.activities.activityChart(encoder.close());
  assert.deepEqual(chart.timeInSec, [0, 1, 2]);
  assert.deepEqual(chart.distanceInCm, [0, 300, 600]);
  assert.deepEqual(chart.powerInWatts, [0, 0, 0]);
  assert.deepEqual(chart.heartRate, [120, 0, 130]);
});

await test('finalization retries and crash recovery preserve one streak update and durable upload intent', async (t) => {
  const f = await mediumFixture(t);
  const fit = readFileSync(new URL('../fixtures/ride.fit', import.meta.url));

  const data = {
    playerId: BigInt(f.rider.player_id),
    courseId: 6n,
    name: 'Once',
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
  const activity = create(ActivitySchema, { ...data, id: BigInt(id) });
  const after = toBinary(StreaksSchema, advancedStreak(streaksFor(f.profiles, f.rider.player_id), activity));
  new Completions(f.accounts.db).prepare(activity.id, f.rider.player_id, toBinary(ActivitySchema, activity), after);
  // Model a crash after the streak file was replaced but before the database commit.
  writeDurable(resolve(f.profiles.folder(f.rider.player_id), 'streaks.bin'), after);
  writeDurable(resolve(f.profiles.folder(f.rider.player_id), 'runalyze_token.txt'), 'test');
  f.services.activities.recover();
  let delivered = 0;
  t.mock.method(globalThis, 'fetch', () => {
    delivered++;

    return Promise.resolve(new Response(null, { status: delivered === 1 ? 503 : 200 }));
  });
  await f.services.uploads.drain();
  assert.equal(f.services.uploads.status(f.rider.player_id)[0]?.state, 'failed');
  const path = `/api/profiles/${f.rider.player_id}/activities/${id}?upload-to-strava=true`;

  for (let i = 0; i < 2; i++) {
    const retry = await f.request(path, { method: 'PUT', ...binary(ActivitySchema, data) });
    assert.equal(retry.status, 200);
  }

  assert.equal(delivered, 1);
  const streaks = await decode(await f.request('/api/fitness/streaks'), StreaksSchema);
  assert.equal(streaks.curStreakDistance, 3000);
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM power_curve').get()?.n, 1);
  const browser = await mediumBrowser(f);
  const retried = await browser.form(`/user/${f.rider.username}/`);
  assert.equal(retried.status, 302);
  await f.services.uploads.drain();
  assert.equal(delivered, 2);
  assert.equal(f.services.uploads.status(f.rider.player_id)[0]?.state, 'sent');

  const changed = await f.request(path, {
    method: 'PUT',
    ...binary(ActivitySchema, { ...data, distanceInMeters: 4000 }),
  });

  assert.equal(changed.status, 409);
});

await test('import recovery discards preparation without a manifest but preserves ambiguous journals', async (t) => {
  const f = await mediumFixture(t);
  const folder = resolve(f.profiles.folder(f.rider.player_id), `.ts-import-${'a'.repeat(32)}`);
  mkdirSync(folder);
  writeDurable(resolve(folder, 'profile.bin'), toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 1n })));
  const imports = new ProfileImports(f.accounts, f.world);
  imports.recover();
  assert.equal(existsSync(folder), false);
  mkdirSync(folder);
  writeDurable(resolve(folder, 'manifest.json'), '{bad');
  assert.throws(() => imports.recover());
  assert.equal(existsSync(folder), true);
});

await test('charts keep records without optional sensors and power curves include the first and exact windows', async (t) => {
  const f = await mediumFixture(t);

  for (const { powers, best } of [
    { powers: [500, 500, 500, 500, 500], best: 500 },
    { powers: [500, 500, 500, 500, 500, 0], best: 500 },
    { powers: [500, 500, undefined, 500, 500], best: 400 },
  ]) {
    const encoder = new Encoder();
    const file: FileIdMesg = { type: 'activity', manufacturer: 'development', product: 1, timeCreated: new Date() };
    encoder.onMesg(z.number().parse(Profile.MesgNum.FILE_ID), file);

    for (const [i, power] of powers.entries()) {
      const record: RecordMesg = {
        timestamp: 1_000_000 + i,
        distance: i * 10,
        speed: 10,
      };

      if (power !== undefined) record.power = power;

      encoder.onMesg(z.number().parse(Profile.MesgNum.RECORD), record);
    }

    const bytes = encoder.close();
    const chart = activityChart(bytes);
    assert.equal(chart.timeInSec.length, powers.length);
    assert.deepEqual(
      chart.heartRate,
      powers.map(() => 0),
    );
    assert.deepEqual(
      chart.powerInWatts,
      powers.map((power = 0) => power),
    );
    f.services.activities.savePowerCurve(f.rider.player_id, bytes);
    assert.equal(f.accounts.db.prepare('SELECT power FROM power_curve ORDER BY id DESC LIMIT 1').get()?.power, best);
  }
});

await test('ghost recordings apply migrated equipment and randomized body overrides without changing identity', async (t) => {
  const f = await mediumFixture(t);
  const configFile = resolve(f.config.storageDir, 'ghost_profile.txt');
  writeDurable(configFile, JSON.stringify({ ride_jersey: 42, bike_frame: 123, is_male: false, random_body: true }));

  const states = [100, 200].map((roadTime) =>
    create(PlayerStateSchema, { id: BigInt(f.rider.player_id), roadTime, f19: (6 << 16) | 4, aux3: 1 << 8 }),
  );

  writeDurable(
    resolve(f.profiles.folder(f.rider.player_id), 'ghosts/6/1/ride.bin'),
    toBinary(GhostSchema, create(GhostSchema, { playerId: f.rider.player_id, states })),
    true,
  );
  f.settings.save(f.rider.player_id, { 'ghosts.enabled': true });

  const simulation = new Simulation({
    ...f,
    config: validateConfig({ ...f.config, ghosts: { profileFile: configFile } }),
  });

  for (const state of states) simulation.receive(BigInt(f.rider.player_id), state);
  const ghost = f.profiles.synthetic.get(BigInt(f.rider.player_id) + 10_000_000n);
  assert.ok(ghost);
  assert.equal(ghost.rideJersey, 42);
  assert.equal(ghost.bikeFrame, 123);
  assert.equal(ghost.isMale, false);
  assert.equal(ghost.firstName, '');
  assert.equal(ghost.lastName, 'Ghost');
});
