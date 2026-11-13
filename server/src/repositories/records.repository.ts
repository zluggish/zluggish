import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export class RecordsRepository {
  constructor(private readonly db: DatabaseSync) {}
  updateRouteResult(...values: SQLInputValue[]) {
    return this.db.prepare('UPDATE route_result SET player_id=? WHERE id=?').run(...values);
  }
  listRouteResult(...values: SQLInputValue[]) {
    return this.db
      .prepare(
        'SELECT route_hash, min(world_time) AS first, max(world_time) AS last FROM route_result WHERE player_id=? GROUP BY route_hash',
      )
      .all(...values);
  }
  findPrivateEvent(...values: SQLInputValue[]) {
    return this.db.prepare('SELECT json FROM private_event WHERE id=?').get(...values);
  }

  segmentLeaderboard(...values: SQLInputValue[]) {
    const query = this.db.prepare('SELECT * FROM segment_result ORDER BY elapsed_ms');
    query.setReadBigInts(true);

    return query.all(...values);
  }
}
