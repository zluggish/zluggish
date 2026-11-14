import { query, SqliteExecutor } from '#src/db/query';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const completion = z.object({
  activity_id: z.number(),
  player_id: z.number(),
  payload: z.instanceof(Uint8Array),
  streak: z.instanceof(Uint8Array).nullable(),
  done: z.number(),
});

type Completion = z.infer<typeof completion>;

export type CompletionState =
  | { status: 'draft' }
  | { status: 'prepared'; saved: Completion }
  | { status: 'completed'; saved: Completion };

/** Per activity: absent -> prepared -> completed. Prepared file effects are replayable. */
export class Completions {
  private readonly executor: SqliteExecutor;

  constructor(readonly db: DatabaseSync) {
    this.executor = new SqliteExecutor(db);
  }

  get(id: bigint) {
    const row = this.executor.get(query.selectFrom('activity_completion').selectAll().where('activity_id', '=', id));

    return row ? completion.parse(row) : null;
  }

  state(id: bigint): CompletionState {
    const saved = this.get(id);

    return saved ? { status: saved.done ? 'completed' : 'prepared', saved } : { status: 'draft' };
  }

  prepare(id: bigint, player: number, payload: Uint8Array, streak: Uint8Array | null) {
    this.executor.run(
      query.insertInto('activity_completion').values({ activity_id: id, player_id: player, payload, streak }),
    );
  }

  unfinished() {
    return this.executor
      .all(query.selectFrom('activity_completion').selectAll().where('done', '=', 0).orderBy('activity_id'))
      .map((row) => completion.parse(row));
  }

  complete(id: bigint, providers: string[], save: () => void) {
    this.db.exec('BEGIN IMMEDIATE');

    try {
      save();

      for (const provider of providers)
        this.executor.run(
          query
            .insertInto('activity_upload')
            .values({ activity_id: id, provider })
            .onConflict((conflict) => conflict.doNothing()),
        );
      this.executor.run(query.updateTable('activity_completion').set({ done: 1 }).where('activity_id', '=', id));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
