import { ConnectionsService } from '#src/services/connections.service';
import { WorkoutsService } from '#src/services/workout.service';
import { AssetFiles } from '#src/repositories/files.repository';
import { mediumFixture, mediumWeb } from '#tests/medium/support';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workoutId = '3f2504e0-4f89-41d3-9a0c-1746aabcdef0';

const xml =
  '<workout_file><name>Stored Ride</name><sportType>bike</sportType><workout>' +
  '<Warmup Duration="300" PowerLow="0.5" PowerHigh="0.7"/>' +
  '<SteadyState Duration="600" Power="0.85"/>' +
  '<Cooldown Duration="300" PowerLow="0.6" PowerHigh="0.4"/>' +
  '</workout></workout_file>';

/** Store one synced Intervals.icu workout planned on `day`, the way the sync does. */
function store(f: Awaited<ReturnType<typeof mediumFixture>>, id: number, day: string) {
  const entry = {
    provider: 'intervals-icu',
    event_id: 42,
    workout_id: workoutId,
    name: 'Intervals Ride',
    description: 'Two blocks at threshold',
    start_date_local: `${day}T08:00:00`,
    icu_training_load: '34',
    filename: `${workoutId}.zwo`,
    synced_at: `${day}T07:00:00.000Z`,
  };

  new AssetFiles().writeDurable(
    resolve(f.profiles.folder(id), 'intervals_icu_workout.json'),
    JSON.stringify(entry),
    true,
  );

  const cache = resolve(f.config.storageDir, 'tp-workouts/intervalsicu');
  mkdirSync(cache, { recursive: true });
  new AssetFiles().writeDurable(resolve(cache, `${workoutId}.zwo`), xml, true);
}

await test('today summarises the synced Intervals.icu workout of today and reports other days', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 13, 12) });
  const f = await mediumFixture(t);
  const today = '2026-11-13';
  const yesterday = '2026-11-12';

  const withoutFiles = f.effects.runSync(WorkoutsService.use((service) => service.today(f.rider.player_id)));

  assert.deepEqual(withoutFiles, {
    day: today,
    connected: false,
    ftp: 0,
    ftpSource: 'none',
    zoneLimits: [0.55, 0.75, 0.9, 1.05, 1.2, 1.5],
    syncedAt: null,
    workouts: [],
    otherDays: [],
  });

  f.effects.runSync(
    ConnectionsService.use((service) => service.save(f.rider.player_id, 'intervals', ['i123', 'medium-key'])),
  );
  store(f, f.rider.player_id, today);

  const synced = f.effects.runSync(WorkoutsService.use((service) => service.today(f.rider.player_id)));

  assert.equal(synced.day, today);
  assert.equal(synced.connected, true);
  assert.equal(synced.ftp, f.profiles.get(f.rider.player_id).ftp);
  assert.equal(synced.ftpSource, f.profiles.get(f.rider.player_id).ftp > 0 ? 'profile' : 'none');
  assert.deepEqual(synced.zoneLimits, [0.55, 0.75, 0.9, 1.05, 1.2, 1.5]);
  assert.equal(synced.syncedAt, `${today}T07:00:00.000Z`);
  assert.deepEqual(synced.otherDays, []);
  assert.equal(synced.workouts.length, 1);
  const [workout] = synced.workouts;
  assert.ok(workout);
  assert.equal(workout.id, workoutId);
  assert.equal(workout.name, 'Intervals Ride');
  assert.equal(workout.description, 'Two blocks at threshold');
  assert.equal(workout.plannedAt, `${today}T08:00:00`);
  assert.equal(workout.load, 34);
  assert.equal(workout.summary.name, 'Stored Ride');
  assert.equal(workout.summary.durationSeconds, 1200);
  assert.equal(workout.summary.segments.length, 3);

  store(f, f.other.player_id, yesterday);

  const earlier = f.effects.runSync(WorkoutsService.use((service) => service.today(f.other.player_id)));

  assert.deepEqual(earlier.workouts, []);
  assert.deepEqual(earlier.otherDays, [yesterday]);
  assert.equal(earlier.syncedAt, `${yesterday}T07:00:00.000Z`);
});

await test('stored Intervals.icu settings replace the profile FTP and zone limits', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 13, 12) });
  const f = await mediumFixture(t);
  const today = '2026-11-13';

  store(f, f.rider.player_id, today);

  new AssetFiles().writeDurable(
    resolve(f.profiles.folder(f.rider.player_id), 'intervals_icu_workout.json'),
    JSON.stringify({
      provider: 'intervals-icu',
      workouts: [
        {
          provider: 'intervals-icu',
          event_id: 42,
          workout_id: workoutId,
          name: 'Intervals Ride',
          start_date_local: `${today}T08:00:00`,
          filename: `${workoutId}.zwo`,
        },
      ],
      settings: { ftp: 280, power_zones: [55, 75, 90, 105, 120, 150, 999] },
    }),
    true,
  );

  const synced = f.effects.runSync(WorkoutsService.use((service) => service.today(f.rider.player_id)));

  assert.equal(synced.ftp, 280);
  assert.equal(synced.ftpSource, 'intervals');
  assert.deepEqual(synced.zoneLimits, [0.55, 0.75, 0.9, 1.05, 1.2, 1.5]);
});

await test('the web app reads today workouts only with a session', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 13, 12) });
  const f = await mediumFixture(t);
  const web = mediumWeb(f, f.rider);
  const day = '2026-11-13';

  const anonymous = await web.app.request('http://local:8080/api/me/workouts/today');
  assert.equal(anonymous.status, 401);

  store(f, f.rider.player_id, day);

  const response = await web.request('/api/me/workouts/today');

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const body: { day: string; workouts: Array<{ name: string; load: number; summary: { durationSeconds: number } }> } =
    await response.json();
  const [first] = body.workouts;
  assert.equal(body.day, day);
  assert.equal(body.workouts.length, 1);
  assert.equal(first?.name, 'Intervals Ride');
  assert.equal(first?.load, 34);
  assert.equal(first?.summary.durationSeconds, 1200);
});
