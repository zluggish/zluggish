import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { create, toBinary } from '@bufbuild/protobuf';
import { z } from 'zod';
import {
  FitnessSchema,
  WeekMetricsSchema,
  DayMetricsSchema,
  SportGoalsSchema,
  GoalMetricsSchema,
} from '#src/protocol/generated/fitness_pb';
import {
  StreaksSchema,
  PowerCurveAggregationMsgSchema,
  BestEffortPointMsgSchema,
} from '#src/protocol/generated/profile_pb';
import { streaksFor, weekRange } from '#src/domain/activities/streaks';
import type { Runtime, RuntimeEnv } from '#src/http/runtime';
import { authenticated } from '#src/http/routes/accounts';

const goalSchema = z.object({
  weekGoalTSS: z.number().nonnegative().default(200),
  weekGoalCalories: z.number().nonnegative().default(2000),
  weekGoalKjs: z.number().nonnegative().default(2000),
  weekGoalDistanceKilometers: z.number().nonnegative().default(100),
  weekGoalDistanceMiles: z.number().nonnegative().default(62.14),
  weekGoalTimeMinutes: z.number().nonnegative().default(180),
  currentGoalSetting: z.enum(['TSS', 'KJ', 'CALORIES', 'DISTANCE', 'TIME']).default('DISTANCE'),
  currentGoalSource: z.string().default('MANUAL'),
  lastUpdated: z.string().default(() => new Date().toISOString()),
});

export function fitnessRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const db = runtime.accounts.db;

  function totals(id: number, start: number, end: number) {
    const row = z
      .object({
        distance: z.number().nullable(),
        elevation: z.number().nullable(),
        moving: z.number().nullable(),
        work: z.number().nullable(),
        calories: z.number().nullable(),
        tss: z.number().nullable(),
      })
      .parse(
        db
          .prepare(
            `SELECT SUM(distanceInMeters) AS distance, SUM(total_elevation) AS elevation, SUM(movingTimeInMs) AS moving, SUM(work) AS work, SUM(calories) AS calories, SUM(tss) AS tss FROM activity WHERE player_id=? AND julianday(start_date) BETWEEN julianday(?) AND julianday(?)`,
          )
          .get(id, new Date(start).toISOString(), new Date(end).toISOString()),
      );

    return {
      distance: row.distance ?? 0,
      elevation: Math.trunc(row.elevation ?? 0),
      movingTime: Math.round((row.moving ?? 0) / 10_000) * 10_000,
      work: Math.trunc(row.work ?? 0),
      calories: Math.trunc(row.calories ?? 0),
      tss: row.tss ?? 0,
      duration: row.moving ?? 0,
    };
  }

  function ewma(id: number, date: number, days: number) {
    let score = 0;

    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(date - i * 86_400_000);
      day.setUTCHours(0, 0, 0, 0);
      score =
        score * Math.exp(-1 / days) +
        totals(id, day.getTime(), day.getTime() + 86_400_000 - 1).tss * (1 - Math.exp(-1 / days));
    }

    return score;
  }

  function week(id: number, date: number) {
    const range = weekRange(date);
    const sum = totals(id, range.start, range.end);
    const end = Math.min(range.end, Date.now());
    const score = ewma(id, end, 42);
    const delta = score - ewma(id, end, 7);

    const status =
      score === 0
        ? 'READY'
        : delta < -30
          ? 'OVERREACHING'
          : delta < 0
            ? 'PRODUCTIVE'
            : delta < 25
              ? 'FRESH'
              : 'DETRAINING';

    const days = [];

    for (let i = 0; i < 7; i++) {
      const start = range.start + i * 86_400_000;
      const sum = totals(id, start, start + 86_400_000 - 1);

      if (!sum.distance) continue;
      const zones = [0, 0, 0, 0, 0, 0, 0];

      for (const row of db
        .prepare(
          'SELECT power_zones FROM activity WHERE player_id=? AND julianday(start_date) BETWEEN julianday(?) AND julianday(?)',
        )
        .all(id, new Date(start).toISOString(), new Date(start + 86_400_000 - 1).toISOString())) {
        if (!row.power_zones) continue;

        const incoming = z.array(z.number()).parse(JSON.parse(z.string().parse(row.power_zones)));

        for (let zone = 0; zone < 7; zone++) zones[zone] = (zones[zone] ?? 0) + (incoming[zone] ?? 0);
      }

      const total = zones.reduce((sum, value) => sum + value, 0);
      days.push({
        ...sum,
        day: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][i] ?? 'mon',
        powerZones: total
          ? zones.map((value, index) => ({
              zone: index + 1,
              percentage: value / total,
            }))
          : [],
      });
    }

    return {
      ...sum,
      start: new Date(range.start).toISOString().slice(0, 10),
      fitnessScore: score,
      status,
      days,
    };
  }

  app.get('/api/fitness/streaks', (c) =>
    c.body(toBinary(StreaksSchema, streaksFor(runtime.profiles, authenticated(c).player_id))),
  );
  app.get('/api/fitness/metrics-and-goals', (c) => {
    const user = authenticated(c);
    const json = c.req.header('Accept')?.includes('application/json');

    const date = json
      ? Date.parse(
          `${c.req.query('year')}-${String(c.req.query('month')).padStart(2, '0')}-${String(c.req.query('weekOf')).padStart(2, '0')}T00:00:00Z`,
        )
      : Date.now();

    if (!Number.isFinite(date)) throw new HTTPException(404);

    const weeks = [week(user.player_id, date), week(user.player_id, date - 604_800_000)];

    const row = db
      .prepare('SELECT * FROM goal_metrics WHERE player_id=? AND lastUpdated<=? ORDER BY lastUpdated DESC LIMIT 1')
      .get(user.player_id, new Date(json ? weekRange(date).end : Date.now()).toISOString());

    const goals = row ? goalSchema.parse(row) : goalSchema.parse({});
    const streak = streaksFor(runtime.profiles, user.player_id).curStreak;

    if (json) {
      const cycling = {
        weekGoalTSS: goals.weekGoalTSS,
        weekGoalCalories: goals.weekGoalCalories,
        weekGoalKjs: goals.weekGoalKjs,
        weekGoalDistanceKilometers: goals.weekGoalDistanceKilometers,
        weekGoalTimeMinutes: goals.weekGoalTimeMinutes,
        lastUpdated: goals.lastUpdated,
      };

      return c.json({
        fitnessMetrics: weeks.map((week) => ({
          startOfWeek: week.start,
          totalDistanceKilometers: week.distance / 1000,
          totalElevationMeters: week.elevation,
          totalDurationMinutes: Math.trunc(week.duration / 60_000),
          totalKilojoules: week.work,
          totalCalories: week.calories,
          totalTSS: week.tss,
          useMetric: runtime.profiles.get(user.player_id).useMetric,
          weekStreak: streak,
          numStreakSavers: 0,
          fitnessScore: week.fitnessScore,
          trainingStatus: week.status,
          days: Object.fromEntries(
            week.days.map((day) => [
              day.day,
              {
                day: day.day,
                distanceKilometers: day.distance / 1000,
                elevationMeters: day.elevation,
                durationMinutes: Math.trunc(day.duration / 60_000),
                kilojoules: day.work,
                calories: day.calories,
                tss: day.tss,
                givenXp: 0,
                powerZonePercentages: Object.fromEntries(
                  Array.from({ length: 7 }, (_, index) => [
                    String(index + 1),
                    day.powerZones[index]?.percentage ?? (index === 0 ? 1 : 0),
                  ]),
                ),
              },
            ]),
          ),
        })),
        goalsMetrics: {
          all: cycling,
          cycling,
          running: null,
          currentGoalSetting: goals.currentGoalSetting,
        },
      });
    }

    const target = create(GoalMetricsSchema, {
      tss: goals.weekGoalTSS,
      calories: goals.weekGoalCalories,
      work: goals.weekGoalKjs,
      distance: Math.trunc(goals.weekGoalDistanceKilometers) * 1000,
      movingTime: goals.weekGoalTimeMinutes * 60_000,
    });

    return c.body(
      toBinary(
        FitnessSchema,
        create(FitnessSchema, {
          streak,
          thisWeek: weeks[0]
            ? create(WeekMetricsSchema, {
                ...weeks[0],
                distance: Math.trunc(weeks[0].distance),
                days: weeks[0].days.map((day) =>
                  create(DayMetricsSchema, {
                    ...day,
                    distance: Math.trunc(day.distance),
                  }),
                ),
              })
            : undefined,
          lastWeek: weeks[1]
            ? create(WeekMetricsSchema, {
                ...weeks[1],
                distance: Math.trunc(weeks[1].distance),
                days: weeks[1].days.map((day) =>
                  create(DayMetricsSchema, {
                    ...day,
                    distance: Math.trunc(day.distance),
                  }),
                ),
              })
            : undefined,
          goals: create(SportGoalsSchema, {
            all: target,
            cycling: target,
            currentGoal: ['TSS', 'KJ', 'CALORIES', 'DISTANCE', 'TIME'].indexOf(goals.currentGoalSetting),
            lastUpdated: BigInt(Date.parse(goals.lastUpdated)),
          }),
        }),
      ),
    );
  });
  app.put('/api/fitness/fitness-goals/history', async (c) => {
    const user = authenticated(c);
    const goals = goalSchema.parse(await c.req.json());
    goals.lastUpdated = new Date().toISOString();
    db.prepare(
      'INSERT INTO goal_metrics (player_id,weekGoalTSS,weekGoalCalories,weekGoalKjs,weekGoalDistanceKilometers,weekGoalDistanceMiles,weekGoalTimeMinutes,lastUpdated,currentGoalSetting,currentGoalSource) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run(
      user.player_id,
      goals.weekGoalTSS,
      goals.weekGoalCalories,
      goals.weekGoalKjs,
      goals.weekGoalDistanceKilometers,
      goals.weekGoalDistanceMiles,
      goals.weekGoalTimeMinutes,
      goals.lastUpdated,
      goals.currentGoalSetting,
      goals.currentGoalSource,
    );

    return c.body(null, 204);
  });
  app.get('/api/power-curve/best/:option', (c) => {
    const user = authenticated(c);

    const days = z.coerce
      .number()
      .int()
      .min(0)
      .max(100_000)
      .parse(c.req.query('days') ?? 30);

    const cutoff = c.req.param('option') === 'last' ? Math.floor(Date.now() / 1000) - days * 86_400 : 0;

    const response = create(PowerCurveAggregationMsgSchema);

    for (const time of ['5', '60', '300', '1200']) {
      const row = db
        .prepare(
          'SELECT power FROM power_curve WHERE player_id=? AND time=? AND timestamp>? ORDER BY power DESC LIMIT 1',
        )
        .get(user.player_id, time, cutoff);

      if (row)
        response.watts[time] = create(BestEffortPointMsgSchema, {
          power: z.number().parse(row.power),
        });
    }

    return c.body(toBinary(PowerCurveAggregationMsgSchema, response));
  });
}
