import { query, SqliteExecutor } from '#src/db/query';
import type { DatabaseSync } from 'node:sqlite';

export const SystemFlag = {
  /** Set by restore; stops every automatic delivery until an operator clears it. */
  UploadPause: 'uploads.paused',
  ZwiftUpdatesAllowed: 'zwift.updates_allowed',
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

  clear(name: SystemFlag) {
    this.executor.run(query.deleteFrom('system_flag').where('name', '=', name));
  }
}
