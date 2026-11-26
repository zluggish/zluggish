import { integer } from '#src/db/values';
import type { IntegerInput } from '#src/db/values';
import { query, SqliteExecutor } from '#src/db/query';
import { atomic } from '#src/db/transaction';
import { activityDirectoryName } from '#src/activity-storage';
import { sql } from 'kysely';
import type { DatabaseSync } from 'node:sqlite';

/** Activity columns without the FIT payload: lists and details never need it. */
const columns = [
  'id',
  'player_id',
  'course_id',
  'name',
  'f5',
  'privateActivity',
  'start_date',
  'end_date',
  'distanceInMeters',
  'avg_heart_rate',
  'max_heart_rate',
  'avg_watts',
  'max_watts',
  'avg_cadence',
  'max_cadence',
  'avg_speed',
  'max_speed',
  'calories',
  'total_elevation',
  'strava_upload_id',
  'strava_activity_id',
  'f22',
  'f23',
  'fit_filename',
  'subgroupId',
  'workoutHash',
  'progressPercentage',
  'sport',
  'date',
  'act_f32',
  'act_f33',
  'act_f34',
  'privacy',
  'fitness_privacy',
  'club_name',
  'movingTimeInMs',
  'work',
  'tss',
  'normalized_power',
  'power_zones',
  'power_units',
] as const;

function ids(rows: Array<{ id: number }>) {
  return new Set(rows.map((row) => row.id));
}

export class ActivitiesRepository {
  private readonly executor: SqliteExecutor;

  constructor(private readonly db: DatabaseSync) {
    this.executor = new SqliteExecutor(db);
  }

  listActivityImage(player: number | bigint, activity: IntegerInput) {
    return this.executor.all(
      query
        .selectFrom('activity_image')
        .select(['id', 'state'])
        .where('player_id', '=', player)
        .where('activity_id', '=', integer(activity)),
    );
  }

  listActivityMedia(player: number | bigint, activity: IntegerInput) {
    return this.executor.all(
      query
        .selectFrom('activity_media')
        .select(['id', 'content_type', 'state'])
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

  /** The owner and folder name of an activity. The name is assigned on first use and
  never changes afterwards, even when the client edits the start date of a draft.
  */
  storageDirectory(id: IntegerInput) {
    const row = this.executor.get(
      query
        .selectFrom('activity')
        .select(['id', 'player_id', 'start_date', 'date', 'end_date', 'storage_dir'])
        .where('id', '=', integer(id)),
      true,
    );

    if (!row || row.player_id === null) {
      return null;
    }
    const player = Number(row.player_id);

    if (row.storage_dir !== null) {
      return { player, directory: row.storage_dir };
    }
    const directory = activityDirectoryName(row.id, [row.start_date, row.date, row.end_date]);

    this.executor.run(
      query
        .updateTable('activity')
        .set({ storage_dir: directory })
        .where('id', '=', integer(id))
        .where('storage_dir', 'is', null),
    );

    return { player, directory };
  }

  listActivityFile(id: IntegerInput) {
    return this.executor.all(query.selectFrom('activity_file').select('id').where('activity_id', '=', integer(id)));
  }

  /** The canonical FIT payload; export files are replaceable copies. */
  fit(id: IntegerInput) {
    const row = this.executor.get(
      query.selectFrom('activity').select(['player_id', 'fit', 'fit_filename']).where('id', '=', integer(id)),
    );

    return row ? { player: row.player_id, fit: row.fit, filename: row.fit_filename ?? '' } : null;
  }

  setFit(id: IntegerInput, fit: Uint8Array) {
    this.executor.run(
      query
        .updateTable('activity')
        .set({ fit: fit.length > 0 ? fit : null })
        .where('id', '=', integer(id)),
    );
  }

  /** Activities of a rider that hold a FIT payload, without loading the payloads. */
  withFit(player: number) {
    return this.executor
      .all(query.selectFrom('activity').select('id').where('player_id', '=', player).where('fit', 'is not', null))
      .map((row) => row.id);
  }

  deleteActivityData(id: IntegerInput, player: number | bigint) {
    atomic(this.db, () => {
      for (const table of [
        'activity_file',
        'activity_image',
        'activity_media',
        'activity_upload',
        'activity_completion',
      ] as const) {
        this.executor.run(query.deleteFrom(table).where('activity_id', '=', integer(id)));
      }
      this.deleteActivity(id, player);
    });
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

  /** Media rows are reserved before their file exists: reserved -> ready | failed.
  Cleanup removes abandoned reservations and their files.
  */
  insertActivityImage(player: number | bigint, activity: IntegerInput) {
    return this.executor.run(
      query
        .insertInto('activity_image')
        .values({ player_id: player, activity_id: integer(activity), state: 'reserved', created_at: Date.now() }),
    );
  }

  insertActivityMedia(player: number | bigint, activity: IntegerInput, contentType: string) {
    return this.executor.run(
      query.insertInto('activity_media').values({
        player_id: player,
        activity_id: integer(activity),
        content_type: contentType,
        state: 'reserved',
        created_at: Date.now(),
      }),
    );
  }

  /** Commit a reserved media row after its file is durable. False when it was removed. */
  mediaState(table: 'activity_image' | 'activity_media', id: IntegerInput, state: 'ready' | 'failed') {
    return (
      this.executor.run(
        query.updateTable(table).set({ state }).where('id', '=', integer(id)).where('state', '=', 'reserved'),
      ).changes !== 0
    );
  }

  /** Identifiers that own files, for orphan detection. */
  owners() {
    return {
      activities: ids(this.executor.all(query.selectFrom('activity').select('id'))),
      charts: ids(this.executor.all(query.selectFrom('activity_file').select('id'))),
      images: ids(this.executor.all(query.selectFrom('activity_image').select('id'))),
      media: ids(this.executor.all(query.selectFrom('activity_media').select('id'))),
    };
  }

  abandonedMedia(table: 'activity_image' | 'activity_media', before: number) {
    return this.executor.all(
      query
        .selectFrom(table)
        .select(['id', 'player_id', 'activity_id'])
        .where(({ eb, or, and }) =>
          or([eb('state', '=', 'failed'), and([eb('state', '=', 'reserved'), eb('created_at', '<', before)])]),
        ),
    );
  }

  deleteMedia(table: 'activity_image' | 'activity_media', id: number) {
    this.executor.run(query.deleteFrom(table).where('id', '=', id));
  }

  findActivityMedia(id: IntegerInput) {
    return this.executor.get(query.selectFrom('activity_media').selectAll().where('id', '=', integer(id)));
  }

  recentActivities(player: number | bigint, viewer: number | bigint) {
    return this.executor.all(
      query
        .selectFrom('activity')
        .select(columns)
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

  ownActivities(player: number | bigint, id?: IntegerInput, page?: number) {
    let selection = query
      .selectFrom('activity')
      .select([
        ...columns,
        sql<number>`fit is not null`.as('has_fit'),
        sql<number>`(SELECT count(*) FROM activity_image i WHERE i.activity_id = activity.id AND i.player_id = activity.player_id AND i.state = 'ready')`.as(
          'image_count',
        ),
      ])
      .where('player_id', '=', player)
      .where('distanceInMeters', '>', 1);

    if (id !== undefined) {
      selection = selection.where('id', '=', integer(id));
    }

    selection = selection.orderBy('date', 'desc').orderBy('id', 'desc');

    if (page !== undefined) {
      selection = selection.limit(21).offset(page * 20);
    }

    return this.executor.all(selection, true);
  }

  activityById(id: IntegerInput) {
    return this.executor.get(query.selectFrom('activity').select(columns).where('id', '=', integer(id)), true);
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
      .select(columns)
      .where('distanceInMeters', '>', 1)
      .where(({ eb, or, and }) =>
        or([
          eb('player_id', '=', viewer),
          and([eb(sql<number>`coalesce(privateActivity, 0)`, '=', 0), eb(sql<number>`coalesce(privacy, 0)`, '=', 0)]),
        ]),
      );

    if (player !== null) {
      selection = selection.where('player_id', '=', player);
    }

    if (before !== null) {
      selection = selection.where('id', '<', integer(before));
    }

    if (!includeUnfinished) {
      selection = selection.where('end_date', 'is not', null);
    }

    return this.executor.all(selection.orderBy('date', 'desc').limit(limit), true);
  }
}
