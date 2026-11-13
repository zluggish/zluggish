import { BestEffortPointMsgSchema, PowerCurveAggregationMsgSchema } from '#src/protocol/generated/profile_pb';
import type { Profiles } from '#src/repositories/profile.repository';
import { streaksFor, weekRange } from '#src/repositories/streak.repository';
import { create } from '@bufbuild/protobuf';
import { z } from 'zod';
import type { FitnessRepository } from '#src/repositories/fitness.repository';

export const goalSchema = z.object({
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

export class FitnessService {
  constructor(
    private readonly repository: FitnessRepository,
    private readonly profiles: Profiles,
  ) {}
  findActivity(...values: Parameters<FitnessRepository['findActivity']>) {
    return this.repository.findActivity(...values);
  }

  private totals(id: number, start: number, end: number) {
    const row = z
      .object({
        distance: z.number().nullable(),
        elevation: z.number().nullable(),
        moving: z.number().nullable(),
        work: z.number().nullable(),
        calories: z.number().nullable(),
        tss: z.number().nullable(),
      })
      .parse(this.repository.findActivity(id, new Date(start).toISOString(), new Date(end).toISOString()));

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

  private ewma(id: number, date: number, days: number) {
    let score = 0;

    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(date - i * 86_400_000);
      day.setUTCHours(0, 0, 0, 0);
      score =
        score * Math.exp(-1 / days) +
        this.totals(id, day.getTime(), day.getTime() + 86_400_000 - 1).tss * (1 - Math.exp(-1 / days));
    }

    return score;
  }

  week(id: number, date: number) {
    const range = weekRange(date);
    const sum = this.totals(id, range.start, range.end);
    const end = Math.min(range.end, Date.now());
    const score = this.ewma(id, end, 42);
    const delta = score - this.ewma(id, end, 7);

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
      const sum = this.totals(id, start, start + 86_400_000 - 1);

      if (!sum.distance) continue;
      const zones = [0, 0, 0, 0, 0, 0, 0];

      for (const row of this.repository.listActivity(
        id,
        new Date(start).toISOString(),
        new Date(start + 86_400_000 - 1).toISOString(),
      )) {
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

  streaks(id: number) {
    return streaksFor(this.profiles, id);
  }
  metrics(id: number, date: number, historical: boolean) {
    const weeks = [this.week(id, date), this.week(id, date - 604_800_000)];

    const row = this.repository.findGoalMetrics(
      id,
      new Date(historical ? weekRange(date).end : Date.now()).toISOString(),
    );

    const goals = goalSchema.parse(row ?? {});

    return { weeks, goals, streak: this.streaks(id).curStreak, useMetric: this.profiles.get(id).useMetric };
  }
  saveGoals(id: number, input: z.infer<typeof goalSchema>) {
    const goals = goalSchema.parse(input);
    goals.lastUpdated = new Date().toISOString();
    this.repository.insertGoalMetrics(
      id,
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
  }
  powerCurve(id: number, option: string, days: number) {
    const cutoff = option === 'last' ? Math.floor(Date.now() / 1000) - days * 86_400 : 0;
    const response = create(PowerCurveAggregationMsgSchema);

    for (const time of ['5', '60', '300', '1200']) {
      const row = this.repository.findPowerCurve(id, time, cutoff);

      if (row) response.watts[time] = create(BestEffortPointMsgSchema, { power: z.number().parse(row.power) });
    }

    return response;
  }
}
