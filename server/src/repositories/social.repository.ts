import { integer } from '#src/db/values';
import type { IntegerInput } from '#src/db/values';
import { query, SqliteExecutor } from '#src/db/query';
import { sql } from 'kysely';
import type { DatabaseSync } from 'node:sqlite';

export class SocialRepository {
  private readonly executor: SqliteExecutor;
  constructor(db: DatabaseSync) {
    this.executor = new SqliteExecutor(db);
  }
  listUser(first: string, last: string, limit: number, offset: number) {
    return this.executor.all(
      query
        .selectFrom('user')
        .select('player_id')
        .where(({ eb, or }) => or([eb('first_name', 'like', first), eb('last_name', 'like', last)]))
        .limit(limit)
        .offset(offset),
    );
  }
  findActivity(player: IntegerInput, since: string) {
    return this.executor.get(
      query
        .selectFrom('activity')
        .select([
          sql<number | null>`sum(cast((julianday(date) - julianday(start_date)) * 1440 as integer))`.as(
            'timeRiddenInMinutes',
          ),
          sql<number | null>`sum(distanceInMeters)`.as('distanceRiddenInMeters'),
          sql<number | null>`sum(calories)`.as('caloriesBurned'),
          sql<number | null>`sum(total_elevation)`.as('heightClimbedInMeters'),
        ])
        .where('player_id', '=', integer(player))
        .where(sql<number>`julianday(start_date)`, '>=', sql<number>`julianday(${since})`),
    );
  }
  insertPlayback(player: number, uuid: string, segment: bigint, time: number, worldTime: bigint, type: number) {
    return this.executor.run(
      query
        .insertInto('playback')
        .values({ player_id: player, uuid, segment_id: segment, time, world_time: worldTime, type }),
    );
  }
  playbackForSegment(
    player: number,
    segment: bigint,
    type: number,
    ignoreStart: number,
    start: bigint,
    ignoreEnd: number,
    end: bigint,
    fastest: number,
  ) {
    let selection = query
      .selectFrom('playback')
      .selectAll()
      .where('player_id', '=', player)
      .where('segment_id', '=', segment)
      .where('type', '=', type);

    if (!ignoreStart) selection = selection.where('world_time', '>', start);

    if (!ignoreEnd) selection = selection.where('world_time', '<', end);

    return this.executor.get(selection.orderBy(fastest ? sql`time` : sql`-world_time`).limit(1), true);
  }
}
