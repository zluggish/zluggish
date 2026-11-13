import { integer } from '#src/db/values';
import type { IntegerInput } from '#src/db/values';
import { query, SqliteExecutor } from '#src/db/query';
import { sql } from 'kysely';
import type { DatabaseSync } from 'node:sqlite';

export class ActivitiesRepository {
  private readonly executor: SqliteExecutor;
  constructor(private readonly db: DatabaseSync) {
    this.executor = new SqliteExecutor(db);
  }

  listActivityImage(player: number | bigint, activity: IntegerInput) {
    return this.executor.all(
      query
        .selectFrom('activity_image')
        .select('id')
        .where('player_id', '=', player)
        .where('activity_id', '=', integer(activity)),
    );
  }
  listActivityMedia(player: number | bigint, activity: IntegerInput) {
    return this.executor.all(
      query
        .selectFrom('activity_media')
        .select(['id', 'content_type'])
        .where('player_id', '=', player)
        .where('activity_id', '=', integer(activity)),
    );
  }
  findActivity(id: IntegerInput, player: number | bigint) {
    return this.executor.get(
      query.selectFrom('activity').select('id').where('id', '=', integer(id)).where('player_id', '=', player),
    );
  }
  deleteActivity(id: IntegerInput, player: number | bigint) {
    return this.executor.run(
      query.deleteFrom('activity').where('id', '=', integer(id)).where('player_id', '=', player),
    );
  }
  listActivityFile(id: IntegerInput) {
    return this.executor.all(query.selectFrom('activity_file').select('id').where('activity_id', '=', integer(id)));
  }
  deleteActivityData(id: IntegerInput, player: number | bigint) {
    this.db.exec('BEGIN IMMEDIATE');

    try {
      for (const table of [
        'activity_file',
        'activity_image',
        'activity_media',
        'activity_upload',
        'activity_completion',
      ] as const)
        this.executor.run(query.deleteFrom(table).where('activity_id', '=', integer(id)));
      this.deleteActivity(id, player);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  findActivityFile(id: IntegerInput) {
    return this.executor.get(
      query.selectFrom('activity_file').select('id').where('activity_id', '=', integer(id)).where('full', '=', 0),
    );
  }
  insertActivityFile(id: IntegerInput) {
    return this.executor.run(query.insertInto('activity_file').values({ activity_id: integer(id), full: 0 }));
  }
  findOwnedActivityFile(id: IntegerInput, activity: IntegerInput) {
    return this.executor.get(
      query
        .selectFrom('activity_file')
        .select('id')
        .where('id', '=', integer(id))
        .where('activity_id', '=', integer(activity))
        .where(({ exists, selectFrom }) =>
          exists(selectFrom('activity').select('id').whereRef('activity.id', '=', 'activity_file.activity_id')),
        ),
    );
  }
  insertActivityImage(player: number | bigint, activity: IntegerInput) {
    return this.executor.run(
      query.insertInto('activity_image').values({ player_id: player, activity_id: integer(activity) }),
    );
  }
  insertActivityMedia(player: number | bigint, activity: IntegerInput, contentType: string) {
    return this.executor.run(
      query
        .insertInto('activity_media')
        .values({ player_id: player, activity_id: integer(activity), content_type: contentType }),
    );
  }
  findActivityMedia(id: IntegerInput) {
    return this.executor.get(query.selectFrom('activity_media').selectAll().where('id', '=', integer(id)));
  }
  recentActivities(player: number | bigint, viewer: number | bigint) {
    return this.executor.all(
      query
        .selectFrom('activity')
        .selectAll()
        .where('player_id', '=', player)
        .where('date', '>', sql<string>`date('now', '-1 month')`)
        .where(({ eb, or, and }) =>
          or([
            eb('player_id', '=', viewer),
            and([eb(sql<number>`coalesce(privateActivity, 0)`, '=', 0), eb(sql<number>`coalesce(privacy, 0)`, '=', 0)]),
          ]),
        )
        .orderBy('id'),
      true,
    );
  }
  activityById(id: IntegerInput) {
    return this.executor.get(query.selectFrom('activity').selectAll().where('id', '=', integer(id)), true);
  }
  activityFeed(
    player: number | null,
    before: string | null,
    includeUnfinished: number,
    viewer: number | bigint,
    limit: number,
  ) {
    let selection = query
      .selectFrom('activity')
      .selectAll()
      .where('distanceInMeters', '>', 1)
      .where(({ eb, or, and }) =>
        or([
          eb('player_id', '=', viewer),
          and([eb(sql<number>`coalesce(privateActivity, 0)`, '=', 0), eb(sql<number>`coalesce(privacy, 0)`, '=', 0)]),
        ]),
      );

    if (player !== null) selection = selection.where('player_id', '=', player);

    if (before !== null) selection = selection.where('id', '<', integer(before));

    if (!includeUnfinished) selection = selection.where('end_date', 'is not', null);

    return this.executor.all(selection.orderBy('date', 'desc').limit(limit), true);
  }
}
