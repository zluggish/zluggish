import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { StreaksSchema } from '#src/protocol/generated/profile_pb';
import { StreakService } from '#src/services/streak.service';
import { clone, create } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('streak weeks run Monday through Sunday in UTC across a year boundary', () => {
  const expected = {
    start: Date.parse('2025-12-29T00:00:00Z'),
    end: Date.parse('2026-01-04T23:59:59Z'),
  };

  for (const date of ['2025-12-29T00:00:00Z', '2026-01-01T12:00:00Z', '2026-01-04T23:59:59Z']) {
    assert.deepEqual(StreakService.weekRange(Date.parse(date)), expected);
  }

  assert.equal(StreakService.weekRange(Date.parse('2026-01-05T00:00:00Z')).start, expected.start + 604_800_000);
});

for (const [name, startDate, count, distance, elevation, calories, maxDistance] of [
  ['same week accumulates without incrementing', '2026-11-15T23:59:59Z', 3, 1500, 150, 600, 1500],
  ['next week continues the streak', '2026-11-16T00:00:00Z', 4, 1500, 150, 600, 1500],
  ['last second of next week still continues', '2026-11-22T23:59:59Z', 4, 1500, 150, 600, 1500],
  ['a missed week resets current totals but preserves records', '2026-11-23T00:00:00Z', 1, 500, 50, 200, 1200],
] as const) {
  await test(name, () => {
    const previous = create(StreaksSchema, {
      curStreak: 3,
      curStreakRide: BigInt(Date.parse('2026-11-09T12:00:00Z')),
      weekEnd: BigInt(Date.parse('2026-11-15T23:59:59Z')),
      curStreakDistance: 1000,
      curStreakElevation: 100,
      curStreakCalories: 400,
      maxStreak: 3,
      maxStreakDistance: 1200,
      maxStreakElevation: 120,
      maxStreakCalories: 500,
    });

    const snapshot = clone(StreaksSchema, previous);

    const next = StreakService.advancedStreak(
      previous,
      create(ActivitySchema, {
        startDate,
        distanceInMeters: 500.9,
        totalElevation: 50.9,
        calories: 200.9,
      }),
    );

    assert.deepEqual(
      next,
      create(StreaksSchema, {
        curStreak: count,
        curStreakRide: count === 3 ? previous.curStreakRide : BigInt(Date.parse(startDate)),
        weekEnd: BigInt(StreakService.weekRange(Date.parse(startDate)).end),
        curStreakDistance: distance,
        curStreakElevation: elevation,
        curStreakCalories: calories,
        maxStreak: Math.max(3, count),
        maxStreakDistance: maxDistance,
        maxStreakElevation: Math.max(120, elevation),
        maxStreakCalories: Math.max(500, calories),
      }),
    );
    assert.deepEqual(previous, snapshot);
  });
}

await test('invalid activity dates leave streaks unchanged', () => {
  const previous = create(StreaksSchema, { curStreak: 7, curStreakDistance: 1234 });

  const next = StreakService.advancedStreak(
    previous,
    create(ActivitySchema, {
      startDate: 'invalid',
      distanceInMeters: 500,
    }),
  );

  assert.deepEqual(next, previous);
  assert.notEqual(next, previous);
});
