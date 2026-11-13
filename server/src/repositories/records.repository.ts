import { query, SqliteExecutor } from '#src/db/query';
import type { DatabaseSync } from 'node:sqlite';

export class RecordsRepository {
  private readonly executor: SqliteExecutor;
  constructor(db: DatabaseSync) {
    this.executor = new SqliteExecutor(db);
  }
  updateRouteResult(player: number, id: number | bigint) {
    return this.executor.run(query.updateTable('route_result').set({ player_id: player }).where('id', '=', id));
  }
  listRouteResult(player: number) {
    return this.executor.all(
      query
        .selectFrom('route_result')
        .select('route_hash')
        .select(({ fn }) => [fn.min('world_time').as('first'), fn.max('world_time').as('last')])
        .where('player_id', '=', player)
        .groupBy('route_hash'),
    );
  }
  findPrivateEvent(id: number | bigint) {
    return this.executor.get(query.selectFrom('private_event').select('json').where('id', '=', id));
  }
  routeBadgeCount(player: number) {
    return (
      this.executor.get(
        query
          .selectFrom('route_result')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('player_id', '=', player)
          .where('route_hash', '>=', 10_000)
          .where('route_hash', '<=', 11_000),
      )?.count ?? 0
    );
  }
  ensureRoute(player: number, hash: number) {
    const existing = this.executor.get(
      query.selectFrom('route_result').select('id').where('player_id', '=', player).where('route_hash', '=', hash),
    );

    if (!existing) this.executor.run(query.insertInto('route_result').values({ player_id: player, route_hash: hash }));
  }

  segmentLeaderboard() {
    return this.executor.all(query.selectFrom('segment_result').selectAll().orderBy('elapsed_ms'), true);
  }
}
