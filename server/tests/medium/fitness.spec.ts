import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create } from '@bufbuild/protobuf';
import { updateStreaks } from '#src/services/streak.service';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { FitnessSchema } from '#src/protocol/generated/fitness_pb';
import { StreaksSchema } from '#src/protocol/generated/profile_pb';
import { mediumFixture, decode } from '#tests/medium/support';

await test('streak ride timestamps persist when starting, extending and restarting a streak', async (t) => {
  const f = await mediumFixture(t);

  for (const [date, count, distance, rideDate] of [
    ['2026-11-02', 1, 3000, '2026-11-02'],
    ['2026-11-03', 1, 6000, '2026-11-02'],
    ['2026-11-09', 2, 9000, '2026-11-09'],
    ['2026-11-30', 1, 3000, '2026-11-30'],
  ] as const) {
    updateStreaks(
      f.profiles,
      f.rider.player_id,
      create(ActivitySchema, { startDate: `${date}T12:00:00Z`, distanceInMeters: 3000 }),
    );

    const streak = await decode(await f.request('/api/fitness/streaks'), StreaksSchema);
    assert.equal(streak.curStreak, count);
    assert.equal(streak.curStreakDistance, distance);
    assert.equal(streak.curStreakRide, BigInt(Date.parse(`${rideDate}T12:00:00Z`)));
  }
});

await test('fitness goals preserve fractional kilometers when serialized as meters', async (t) => {
  const f = await mediumFixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 13, 12) });

  for (const [kilometers, meters] of [
    [0.5, 500],
    [100.5, 100_500],
    [250, 250_000],
  ]) {
    const response = await f.request('/api/fitness/fitness-goals/history', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekGoalDistanceKilometers: kilometers }),
    });

    assert.equal(response.status, 204);

    const fitness = await decode(await f.request('/api/fitness/metrics-and-goals'), FitnessSchema);
    assert.equal(fitness.goals?.all?.distance, meters);
    assert.equal(fitness.goals?.cycling?.distance, meters);
    t.mock.timers.tick(1000);
  }
});
