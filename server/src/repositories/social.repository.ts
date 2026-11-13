import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export class SocialRepository {
  constructor(private readonly db: DatabaseSync) {}
  listUser(...values: SQLInputValue[]) {
    return this.db
      .prepare('SELECT player_id FROM user WHERE first_name LIKE ? OR last_name LIKE ? LIMIT ? OFFSET ?')
      .all(...values);
  }
  findActivity(...values: SQLInputValue[]) {
    return this.db
      .prepare(
        'SELECT SUM(CAST((julianday(date)-julianday(start_date))*1440 AS INTEGER)) AS timeRiddenInMinutes, SUM(distanceInMeters) AS distanceRiddenInMeters, SUM(calories) AS caloriesBurned, SUM(total_elevation) AS heightClimbedInMeters FROM activity WHERE player_id=? AND julianday(start_date)>=julianday(?)',
      )
      .get(...values);
  }
  insertPlayback(...values: SQLInputValue[]) {
    return this.db
      .prepare('INSERT INTO playback (player_id,uuid,segment_id,time,world_time,type) VALUES (?,?,?,?,?,?)')
      .run(...values);
  }

  playbackForSegment(...values: SQLInputValue[]) {
    const query = this.db.prepare(
      'SELECT * FROM playback WHERE player_id=? AND segment_id=? AND type=? AND (? OR world_time>?) AND (? OR world_time<?) ORDER BY CASE WHEN ? THEN time ELSE -world_time END LIMIT 1',
    );

    query.setReadBigInts(true);

    return query.get(...values);
  }
}
