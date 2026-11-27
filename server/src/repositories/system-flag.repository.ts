import { query, SqliteExecutor } from '#src/db/query';
import type { DatabaseSync } from 'node:sqlite';

export const SystemFlag = {
  /** Set by restore; stops every automatic delivery until an operator clears it. */
  UploadPause: 'uploads.paused',
  ZwiftUpdatesAllowed: 'zwift.updates_allowed',
  /** The highest player ID ever deleted. New riders are numbered above it, so a deleted
  rider's ID, folder and cached state never pass to someone else.
  */
  RetiredPlayerId: 'accounts.retired_player_id',
} as const;

export type SystemFlag = (typeof SystemFlag)[keyof typeof SystemFlag];

export class SystemFlagsRepository {
  private readonly executor: SqliteExecutor;

  constructor(db: DatabaseSync) {
    this.executor = new SqliteExecutor(db);
  }

  get(name: SystemFlag) {
    return this.executor.get(query.selectFrom('system_flag').select('value').where('name', '=', name))?.value ?? null;
  }

  set(name: SystemFlag, value: string) {
    this.executor.run(
      query
        .insertInto('system_flag')
        .values({ name, value })
        .onConflict((conflict) => conflict.column('name').doUpdateSet({ value })),
    );
  }

  /** The highest deleted player ID, or 0. */
  retiredPlayerId() {
    return Number(this.get(SystemFlag.RetiredPlayerId) ?? 0);
  }

  retirePlayerId(player: number) {
    this.set(SystemFlag.RetiredPlayerId, String(Math.max(this.retiredPlayerId(), player)));
  }

  clear(name: SystemFlag) {
    this.executor.run(query.deleteFrom('system_flag').where('name', '=', name));
  }
}
