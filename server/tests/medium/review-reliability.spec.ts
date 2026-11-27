import { ActivitiesService } from '#src/services/activities.service';
import { makeAppRuntime } from '#src/layers';
import { DocumentsService } from '#src/services/documents.service';
import { validateConfig } from '#src/config/index';
import { createGameApp } from '#src/http/app';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { PlayerProfileSchema, StreaksSchema } from '#src/protocol/generated/profile_pb';
import { GhostSchema, PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { AssetFiles } from '#src/repositories/files.repository';
import { LoggingRepository } from '#src/repositories/logging.repository';
import { AccountsService } from '#src/services/auth.service';
import { FitService } from '#src/services/fit.service';
import { ImportsService } from '#src/services/profile-import.service';
import { JobsService } from '#src/services/jobs.service';
import { UploadsService } from '#src/services/uploads.service';
import { Simulation } from '#src/world/simulation';
import { binary, decode, mediumFixture, mediumWeb } from '#tests/medium/support';
import { create, toBinary } from '@bufbuild/protobuf';
import { Encoder, Profile } from '@garmin/fitsdk';
import type { FileIdMesg, RecordMesg } from '@garmin/fitsdk';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Schema } from 'effect';

await test('deleting a queued activity while another upload is sending prevents its later delivery', async (t) => {
  const f = await mediumFixture(t);
  f.effects.runSync(DocumentsService.use((service) => service.put(f.rider.player_id, 'runalyze_token.txt', 'test')));
  const ids: Array<number> = [];

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

    const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(await response.json());
    f.effects.runSync(
      ActivitiesService.use((service) => service.finalize(create(ActivitySchema, { ...data, id: BigInt(id) }))),
    );
    ids.push(id);
  }

  const delivery = new EventEmitter();
  const released = once(delivery, 'release');

  const uploads = t.mock.method(globalThis, 'fetch', async () => {
    await released;

    return new Response(null, { status: 200 });
  });

  const deleted = await f.request(`/api/profiles/${f.rider.player_id}/activities/${ids[1]}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  const draining = f.effects.runPromise(JobsService.use((service) => service.drain()));
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  delivery.emit('release');
  await draining;
  assert.equal(uploads.mock.callCount(), 1);
  assert.deepEqual(f.effects.runSync(UploadsService.use((service) => service.status(f.rider.player_id))), [
    { activity_id: ids[0], provider: 'runalyze', state: 'sent', last_error: null },
  ]);
});

await test('a failed completion transaction commits nothing and a repeated save completes once', async (t) => {
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
  const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(await first.json());
  f.accounts.db.exec(`CREATE TRIGGER fail_completion BEFORE INSERT ON activity_completion
    BEGIN SELECT RAISE(ABORT, 'injected completion failure'); END`);

  const finish = () =>
    f.request(`${base}/${id}?upload-to-strava=true`, {
      method: 'PUT',
      ...binary(ActivitySchema, { ...data, name: 'Final name' }),
    });

  const failed = await finish();
  assert.equal(failed.status, 500);
  assert.equal(f.accounts.db.prepare('SELECT name FROM activity WHERE id=?').get(id)?.name, 'Before failure');
  assert.equal(f.accounts.db.prepare('SELECT fit FROM activity WHERE id=?').get(id)?.fit, null);
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM job').get()?.n, 0);
  assert.equal(
    f.effects.runSync(DocumentsService.use((service) => service.has(f.rider.player_id, 'streaks.bin'))),
    false,
  );
  f.accounts.db.exec('DROP TRIGGER fail_completion');

  for (let i = 0; i < 2; i++) {
    const saved = await finish();
    assert.equal(saved.status, 200);
  }

  await f.effects.runPromise(JobsService.use((service) => service.drain()));
  const streaks = await decode(await f.request('/api/fitness/streaks'), StreaksSchema);
  assert.equal(streaks.curStreakDistance, 3000);
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM power_curve').get()?.n, 1);
  assert.equal(f.accounts.db.prepare('SELECT name FROM activity WHERE id=?').get(id)?.name, 'Final name');
  assert.deepEqual(
    Buffer.from(
      Schema.decodeUnknownSync(Schema.instanceOf(Uint8Array))(
        f.accounts.db.prepare('SELECT fit FROM activity WHERE id=?').get(id)?.fit,
      ),
    ),
    Buffer.from(data.fit),
  );
});

await test('reopened delivery queues mark interrupted sends ambiguous and honor disconnection', async (t) => {
  const f = await mediumFixture(t);
  f.effects.runSync(DocumentsService.use((service) => service.put(f.rider.player_id, 'runalyze_token.txt', 'test')));

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

  const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(await response.json());
  f.effects.runSync(
    ActivitiesService.use((service) => service.finalize(create(ActivitySchema, { ...data, id: BigInt(id) }))),
  );
  f.accounts.db.exec("UPDATE activity_upload SET state='sending'");
  f.accounts.close();
  const reopened = AccountsService.open(f.accounts.storage);
  const context = { ...f, accounts: reopened, settings: reopened.repositories.settingsRepository };
  const effects = makeAppRuntime(context);
  Object.assign(context, { effects });
  const queue = effects.runSync(UploadsService);
  const jobs = effects.runSync(JobsService);

  // Windows cannot remove the fixture directory while the reopened SQLite handle is live.
  // Scoped cleanup runs before runtimeFixture's after hook, including on assertion failure.
  try {
    effects.runSync(queue.start());
    await effects.runPromise(jobs.drain());
    assert.equal(effects.runSync(queue.status(f.rider.player_id))[0]?.state, 'ambiguous');
    await effects.runPromise(queue.retry(f.rider.player_id));
    assert.equal(effects.runSync(queue.status(f.rider.player_id))[0]?.state, 'ambiguous');
    await effects.runPromise(queue.retry(f.other.player_id, true));
    assert.equal(effects.runSync(queue.status(f.rider.player_id))[0]?.state, 'ambiguous');
    assert.deepEqual(effects.runSync(queue.status(f.other.player_id)), []);
    reopened.repositories.riderDocuments.remove(f.rider.player_id, 'runalyze_token.txt');
    await effects.runPromise(queue.retry(f.rider.player_id, true));
    assert.equal(effects.runSync(queue.status(f.rider.player_id))[0]?.state, 'cancelled');
  } finally {
    try {
      await effects.runPromise(jobs.close());
      await effects.dispose();
    } finally {
      reopened.close();
    }
  }
});

await test('configured logging level controls request logging and application diagnostics', async (t) => {
  const f = await mediumFixture(t);
  const info = t.mock.method(console, 'log', () => {});
  const warning = t.mock.method(console, 'warn', () => {});
  const error = t.mock.method(console, 'error', () => {});
  const log = new LoggingRepository({ level: 'ERROR' });
  const response = await f.request('/health');
  assert.equal(response.status, 200);
  log.warn('test.warning', 'suppressed');
  log.error('test.error', 'visible');
  assert.equal(info.mock.callCount(), 0);
  assert.equal(warning.mock.callCount(), 0);
  assert.equal(error.mock.callCount(), 1);
  log.configure({ level: 'INFO' });
  await f.request('/health');
  assert.equal(info.mock.callCount(), 0, 'Routine requests stay quiet at INFO');
  f.world.lifecycle.log = new LoggingRepository({ level: 'VERBOSE' });
  const verboseApp = createGameApp({ gameInfo: '{}', gameInfoHash: '0', variants: '{}' }, f);
  await verboseApp.request('/health?token=never-log-this');
  assert.equal(info.mock.callCount(), 1);
  assert.match(String(info.mock.calls[0]?.arguments[0]), /VERBOSE GET \/health → 200 \(\d+ ms\)$/);
  assert.doesNotMatch(String(info.mock.calls[0]?.arguments[0]), /never-log-this/);
});

await test('charts retain running records with no power and intermittent sensor dropouts', async (t) => {
  const f = await mediumFixture(t);
  const encoder = new Encoder();

  const records: Array<RecordMesg> = [
    { timestamp: 1_000_000, distance: 0, speed: 3, heartRate: 120 },
    { timestamp: 1_000_001, distance: 3, speed: 3 },
    { timestamp: 1_000_002, distance: 6, speed: 3, heartRate: 130 },
  ];

  for (const record of records) {
    encoder.onMesg(Schema.decodeUnknownSync(Schema.Finite)(Profile.MesgNum.RECORD), record);
  }
  const chart = f.effects.runSync(ActivitiesService.use((service) => service.activityChart(encoder.close())));
  assert.deepEqual(chart.timeInSec, [0, 1, 2]);
  assert.deepEqual(chart.distanceInCm, [0, 300, 600]);
  assert.deepEqual(chart.powerInWatts, [0, 0, 0]);
  assert.deepEqual(chart.heartRate, [120, 0, 130]);
});

await test('repeated finalization keeps one streak update and deliveries retry only on request', async (t) => {
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

  const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(await response.json());
  f.effects.runSync(DocumentsService.use((service) => service.put(f.rider.player_id, 'runalyze_token.txt', 'test')));
  let delivered = 0;
  t.mock.method(globalThis, 'fetch', () => {
    delivered++;

    return Promise.resolve(new Response(null, { status: delivered === 1 ? 400 : 200 }));
  });
  const path = `/api/profiles/${f.rider.player_id}/activities/${id}?upload-to-strava=true`;

  for (let i = 0; i < 3; i++) {
    const saved = await f.request(path, { method: 'PUT', ...binary(ActivitySchema, data) });
    assert.equal(saved.status, 200);
  }

  await f.effects.runPromise(JobsService.use((service) => service.drain()));
  assert.equal(delivered, 1);
  assert.equal(
    f.effects.runSync(UploadsService.use((service) => service.status(f.rider.player_id)))[0]?.state,
    'failed',
  );
  const streaks = await decode(await f.request('/api/fitness/streaks'), StreaksSchema);
  assert.equal(streaks.curStreakDistance, 3000);
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM power_curve').get()?.n, 1);
  const retried = await mediumWeb(f, f.rider).request('/api/me/uploads/retry', 'POST', {});
  assert.equal(retried.status, 200);
  await f.effects.runPromise(JobsService.use((service) => service.drain()));
  assert.equal(delivered, 2);
  assert.equal(f.effects.runSync(UploadsService.use((service) => service.status(f.rider.player_id)))[0]?.state, 'sent');

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
  new AssetFiles().writeDurable(
    resolve(folder, 'profile.bin'),
    toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 1n })),
  );
  const imports = f.effects.runSync(ImportsService);
  f.effects.runSync(imports.recover());
  assert.equal(existsSync(folder), false);
  mkdirSync(folder);
  new AssetFiles().writeDurable(resolve(folder, 'manifest.json'), '{bad');
  assert.throws(() => f.effects.runSync(imports.recover()));
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
    encoder.onMesg(Schema.decodeUnknownSync(Schema.Finite)(Profile.MesgNum.FILE_ID), file);

    for (const [i, power] of powers.entries()) {
      const record: RecordMesg = {
        timestamp: 1_000_000 + i,
        distance: i * 10,
        speed: 10,
      };

      if (power !== undefined) {
        record.power = power;
      }

      encoder.onMesg(Schema.decodeUnknownSync(Schema.Finite)(Profile.MesgNum.RECORD), record);
    }

    const bytes = encoder.close();
    const chart = FitService.activityChart(bytes);
    assert.equal(chart.timeInSec.length, powers.length);
    assert.deepEqual(
      chart.heartRate,
      powers.map(() => 0),
    );
    assert.deepEqual(
      chart.powerInWatts,
      powers.map((power = 0) => power),
    );
    f.effects.runSync(ActivitiesService.use((service) => service.savePowerCurve(f.rider.player_id, bytes)));
    assert.equal(f.accounts.db.prepare('SELECT power FROM power_curve ORDER BY id DESC LIMIT 1').get()?.power, best);
  }
});

await test('ghost recordings apply migrated equipment and randomized body overrides without changing identity', async (t) => {
  const f = await mediumFixture(t);
  const configFile = resolve(f.config.storageDir, 'ghost_profile.txt');
  new AssetFiles().writeDurable(
    configFile,
    JSON.stringify({ ride_jersey: 42, bike_frame: 123, is_male: false, random_body: true }),
  );

  const states = [100, 200].map((roadTime) =>
    create(PlayerStateSchema, { id: BigInt(f.rider.player_id), roadTime, f19: (6 << 16) | 4, aux3: 1 << 8 }),
  );

  new AssetFiles().writeDurable(
    resolve(f.profiles.folder(f.rider.player_id), 'ghosts/6/1/ride.bin'),
    toBinary(GhostSchema, create(GhostSchema, { playerId: f.rider.player_id, states })),
    true,
  );
  f.settings.save(f.rider.player_id, { 'ghosts.enabled': true });

  const simulation = new Simulation({
    ...f,
    config: validateConfig({ ...f.config, ghosts: { profileFile: configFile } }),
  });

  t.after(() => simulation.close());
  await simulation.ready;

  for (const state of states) {
    simulation.receive(BigInt(f.rider.player_id), state);
  }
  await simulation.idle();
  const ghost = f.profiles.synthetic.get(BigInt(f.rider.player_id) + 10_000_000n);
  assert.ok(ghost);
  assert.equal(ghost.rideJersey, 42);
  assert.equal(ghost.bikeFrame, 123);
  assert.equal(ghost.isMale, false);
  assert.equal(ghost.firstName, '');
  assert.equal(ghost.lastName, 'Ghost');
});
