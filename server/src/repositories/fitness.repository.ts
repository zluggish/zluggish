import { query, SqliteExecutor } from '#src/db/query';
import { sql } from 'kysely';
import type { DatabaseSync } from 'node:sqlite';

export class FitnessRepository {
  private readonly executor: SqliteExecutor;

  constructor(db: DatabaseSync) {
    this.executor = new SqliteExecutor(db);
  }

  private activities(player: number, start: string, end: string) {
    return query
      .selectFrom('activity')
      .where('player_id', '=', player)
      .where(sql<number>`julianday(start_date)`, '>=', sql<number>`julianday(${start})`)
      .where(sql<number>`julianday(start_date)`, '<=', sql<number>`julianday(${end})`);
  }

  findActivity(player: number, start: string, end: string) {
    return this.executor.get(
      this.activities(player, start, end).select(({ fn }) => [
        fn.sum<number | null>('distanceInMeters').as('distance'),
        fn.sum<number | null>('total_elevation').as('elevation'),
        fn.sum<number | null>('movingTimeInMs').as('moving'),
        fn.sum<number | null>('work').as('work'),
        fn.sum<number | null>('calories').as('calories'),
        fn.sum<number | null>('tss').as('tss'),
      ]),
    );
  }

  listActivity(player: number, start: string, end: string) {
    return this.executor.all(this.activities(player, start, end).select('power_zones'));
  }

  findGoalMetrics(player: number, date: string) {
    return this.executor.get(
      query
        .selectFrom('goal_metrics')
        .selectAll()
        .where('player_id', '=', player)
        .where('lastUpdated', '<=', date)
        .orderBy('lastUpdated', 'desc')
        .limit(1),
    );
  }

  insertGoalMetrics(
    player: number,
    tss: number,
    calories: number,
    kjs: number,
    kilometers: number,
    miles: number,
    minutes: number,
    updated: string,
    setting: string,
    source: string,
  ) {
    return this.executor.run(
      query.insertInto('goal_metrics').values({
        player_id: player,
        weekGoalTSS: tss,
        weekGoalCalories: calories,
        weekGoalKjs: kjs,
        weekGoalDistanceKilometers: kilometers,
        weekGoalDistanceMiles: miles,
        weekGoalTimeMinutes: minutes,
        lastUpdated: updated,
        currentGoalSetting: setting,
        currentGoalSource: source,
      }),
    );
  }

  deletePowerCurve(player: number) {
    return this.executor.run(query.deleteFrom('power_curve').where('player_id', '=', player));
  }

  insertPowerCurve(player: number, time: string, power: number, powerPerKg: number, timestamp: number) {
    this.executor.run(
      query.insertInto('power_curve').values({ player_id: player, time, power, power_wkg: powerPerKg, timestamp }),
    );
  }

  findPowerCurve(player: number, time: string, cutoff: number) {
    return this.executor.get(
      query
        .selectFrom('power_curve')
        .select('power')
        .where('player_id', '=', player)
        .where('time', '=', time)
        .where('timestamp', '>', cutoff)
        .orderBy('power', 'desc')
        .limit(1),
    );
  }
}
