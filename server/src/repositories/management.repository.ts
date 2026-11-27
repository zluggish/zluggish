import { query, SqliteExecutor } from '#src/db/query';
import { immediate } from '#src/db/transaction';
import type { Database } from '#src/db/schema';
import type { Updateable } from 'kysely';
import { sql } from 'kysely';
import type { DatabaseSync } from 'node:sqlite';

import type { JsonValue } from '#src/dtos/management.dto';

export class ManagementRepository {
  private readonly executor: SqliteExecutor;

  constructor(private readonly db: DatabaseSync) {
    this.executor = new SqliteExecutor(db);
  }

  transaction<T>(operation: () => T) {
    return immediate(this.db, operation);
  }

  complete() {
    return (
      this.executor.get(query.selectFrom('web_setup_state').select('state').where('id', '=', 1))?.state === 'complete'
    );
  }

  finish() {
    this.executor.run(query.updateTable('web_setup_state').set({ state: 'complete' }).where('id', '=', 1));
  }

  administrators() {
    return this.executor.all(
      query.selectFrom('user').select('player_id').where('role', '=', 'administrator').where('enabled', '=', 1),
    ).length;
  }

  update(id: number, values: Updateable<Database['user']>, revoke = true) {
    this.executor.run(
      query
        .updateTable('user')
        .set({ ...values, revision: sql`revision + 1`, ...(revoke && { auth_version: sql`auth_version + 1` }) })
        .where('player_id', '=', id),
    );

    if (revoke) {
      this.executor.run(
        query
          .deleteFrom('rider_document')
          .where('player_id', '=', id)
          .where('name', 'in', ['encryption_key.bin', 'relay-auth-version']),
      );
    }
  }

  /** When each rider last signed in and last started an activity, for the user list. */
  recency() {
    const rows = this.executor.all(
      query.selectFrom('user').select((eb) => [
        'player_id',
        'last_login',
        eb
          .selectFrom('activity')
          .select((inner) => inner.fn.max<string | null>('start_date').as('start'))
          .whereRef('activity.player_id', '=', 'user.player_id')
          .as('last_ride'),
      ]),
    );

    return new Map(
      rows.map((row) => {
        const ride = Date.parse(row.last_ride ?? '');

        return [row.player_id, { last_login: row.last_login, last_ride: Number.isNaN(ride) ? null : ride }];
      }),
    );
  }

  /** What deleting a rider removes, for the confirmation the administrator reads first. */
  footprint(player: number) {
    const row = this.executor.get(
      query
        .selectFrom('activity')
        .select((eb) => [
          eb.fn.countAll<number>().as('activities'),
          eb.fn.coalesce(eb.fn.sum<number>('distanceInMeters'), eb.lit(0)).as('distance'),
          eb.fn.coalesce(eb.fn.sum<number>('movingTimeInMs'), eb.lit(0)).as('moving'),
          eb.fn.min<string | null>('start_date').as('first'),
          eb.fn.max<string | null>('start_date').as('last'),
        ])
        .where('player_id', '=', player),
    );

    return {
      activities: row?.activities ?? 0,
      distance: row?.distance ?? 0,
      moving: row?.moving ?? 0,
      first: row?.first || null,
      last: row?.last || null,
    };
  }

  /** Every row that belongs to a rider. Documents, bookmarks and access group membership
  follow the account through their foreign keys. The rider folder is removed by a job.
  */
  removeRider(player: number) {
    const activities = query.selectFrom('activity').select('id').where('player_id', '=', player);

    for (const table of [
      'activity_file',
      'activity_image',
      'activity_media',
      'activity_upload',
      'activity_completion',
    ] as const) {
      this.executor.run(query.deleteFrom(table).where('activity_id', 'in', activities));
    }

    for (const table of [
      'activity',
      'activity_image',
      'activity_media',
      'activity_completion',
      'segment_result',
      'route_result',
      'goal',
      'goal_metrics',
      'playback',
      'power_curve',
      'zfile',
      'notification',
      'rider_settings',
      'rider_import',
    ] as const) {
      this.executor.run(query.deleteFrom(table).where('player_id', '=', player));
    }

    this.executor.run(query.deleteFrom('management_operation').where('actor_player_id', '=', player));
    this.db.prepare("DELETE FROM web_session WHERE identity LIKE ? || ':%'").run(String(player));
    this.executor.run(query.deleteFrom('user').where('player_id', '=', player));
  }

  operation(actor: number, id: string) {
    return this.executor.get(
      query
        .selectFrom('management_operation')
        .selectAll()
        .where('actor_player_id', '=', actor)
        .where('operation_id', '=', id),
    );
  }

  record(actor: number, id: string, action: string, target: number, fingerprint: string, result: JsonValue) {
    this.executor.run(
      query.insertInto('management_operation').values({
        actor_player_id: actor,
        operation_id: id,
        action,
        target: String(target),
        fingerprint,
        status: 'complete',
        result: JSON.stringify(result),
        created_at: Date.now(),
        updated_at: Date.now(),
      }),
    );
  }

  intent(actor: number, operation: string, action: string, fingerprint: string) {
    this.executor.run(
      query.insertInto('management_operation').values({
        actor_player_id: actor,
        operation_id: operation,
        action,
        target: 'server',
        fingerprint,
        status: 'unknown',
        result: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      }),
    );
  }

  finishOperation(actor: number, operation: string, result: JsonValue) {
    this.executor.run(
      query
        .updateTable('management_operation')
        .set({ status: 'complete', result: JSON.stringify(result), updated_at: Date.now() })
        .where('actor_player_id', '=', actor)
        .where('operation_id', '=', operation),
    );
  }
}
