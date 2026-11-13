import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export class FitnessRepository {
  constructor(private readonly db: DatabaseSync) {}
  findActivity(...values: SQLInputValue[]) {
    return this.db
      .prepare(
        `SELECT SUM(distanceInMeters) AS distance, SUM(total_elevation) AS elevation, SUM(movingTimeInMs) AS moving, SUM(work) AS work, SUM(calories) AS calories, SUM(tss) AS tss FROM activity WHERE player_id=? AND julianday(start_date) BETWEEN julianday(?) AND julianday(?)`,
      )
      .get(...values);
  }
  listActivity(...values: SQLInputValue[]) {
    return this.db
      .prepare(
        'SELECT power_zones FROM activity WHERE player_id=? AND julianday(start_date) BETWEEN julianday(?) AND julianday(?)',
      )
      .all(...values);
  }
  findGoalMetrics(...values: SQLInputValue[]) {
    return this.db
      .prepare('SELECT * FROM goal_metrics WHERE player_id=? AND lastUpdated<=? ORDER BY lastUpdated DESC LIMIT 1')
      .get(...values);
  }
  insertGoalMetrics(...values: SQLInputValue[]) {
    return this.db
      .prepare(
        'INSERT INTO goal_metrics (player_id,weekGoalTSS,weekGoalCalories,weekGoalKjs,weekGoalDistanceKilometers,weekGoalDistanceMiles,weekGoalTimeMinutes,lastUpdated,currentGoalSetting,currentGoalSource) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(...values);
  }
  findPowerCurve(...values: SQLInputValue[]) {
    return this.db
      .prepare('SELECT power FROM power_curve WHERE player_id=? AND time=? AND timestamp>? ORDER BY power DESC LIMIT 1')
      .get(...values);
  }
}
