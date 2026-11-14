import { authenticated } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import {
  DayMetricsSchema,
  FitnessSchema,
  GoalMetricsSchema,
  SportGoalsSchema,
  WeekMetricsSchema,
} from '#src/protocol/generated/fitness_pb';
import { PowerCurveAggregationMsgSchema, StreaksSchema } from '#src/protocol/generated/profile_pb';
import { goalSchema } from '#src/dtos/fitness.dto';
import { create, toBinary } from '@bufbuild/protobuf';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

export function fitnessRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const service = runtime.services.fitness;

  app.get('/api/fitness/streaks', (c) => c.body(toBinary(StreaksSchema, service.streaks(authenticated(c).player_id))));
  app.get('/api/fitness/metrics-and-goals', (c) => {
    const user = authenticated(c);
    const json = c.req.header('Accept')?.includes('application/json');

    const date = json
      ? Date.parse(
          `${c.req.query('year')}-${String(c.req.query('month')).padStart(2, '0')}-${String(c.req.query('weekOf')).padStart(2, '0')}T00:00:00Z`,
        )
      : Date.now();

    if (!Number.isFinite(date)) throw new HTTPException(404);

    const { weeks, goals, streak, useMetric } = service.metrics(user.player_id, date, !!json);

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
          useMetric,
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
      distance: Math.trunc(goals.weekGoalDistanceKilometers * 1000),
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
    service.saveGoals(user.player_id, goalSchema.parse(await c.req.json()));

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

    const response = service.powerCurve(user.player_id, c.req.param('option'), days);

    return c.body(toBinary(PowerCurveAggregationMsgSchema, response));
  });
}
