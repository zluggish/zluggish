import { query, SqliteExecutor } from '#src/db/query';
import { sql } from 'kysely';
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

  /** The route of an activity: the hash in the latest route result that the game saved for it. */
  routeOfActivity(player: number, activity: number) {
    return (
      this.executor.get(
        query
          .selectFrom('route_result')
          .select('route_hash')
          .where('player_id', '=', player)
          .where('activity_id', '=', activity)
          .orderBy('id', 'desc')
          .limit(1),
      )?.route_hash ?? null
    );
  }

  ensureRoute(player: number, hash: number) {
    const existing = this.executor.get(
      query.selectFrom('route_result').select('id').where('player_id', '=', player).where('route_hash', '=', hash),
    );

    if (!existing) this.executor.run(query.insertInto('route_result').values({ player_id: player, route_hash: hash }));
  }

  /** Fastest results first, for one segment when given, since a world time when given. */
  segmentLeaderboard(segment: bigint | null, since: bigint | null) {
    let selection = query.selectFrom('segment_result').selectAll();

    if (segment !== null) selection = selection.where('segment_id', '=', segment);

    if (since !== null) selection = selection.where('world_time', '>', since);

    return this.executor.all(selection.orderBy('elapsed_ms'), true);
  }

  /** One rider's results, optionally for one segment and sport. */
  riderSegments(player: bigint, segment: bigint | null, sport: number | null) {
    let selection = query.selectFrom('segment_result').selectAll().where('player_id', '=', player);

    if (segment !== null) selection = selection.where('segment_id', '=', segment);

    // A missing sport decodes as cycling (0), as the protobuf default.
    if (sport !== null) selection = selection.where(sql<number>`coalesce(sport, 0)`, '=', sport);

    return this.executor.all(selection.orderBy('id'), true);
  }
}
