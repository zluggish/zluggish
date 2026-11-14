import type { UploadState } from '#src/enum';
import { query, SqliteExecutor } from '#src/db/query';
import type { DatabaseSync } from 'node:sqlite';

export class UploadsRepository {
  private readonly executor: SqliteExecutor;

  constructor(db: DatabaseSync) {
    this.executor = new SqliteExecutor(db);
  }

  private jobs() {
    return query
      .selectFrom('activity_upload as u')
      .innerJoin('activity_completion as c', 'c.activity_id', 'u.activity_id');
  }

  status(player: number) {
    return this.executor.all(
      this.jobs()
        .select(['u.activity_id', 'u.provider', 'u.state'])
        .where('c.player_id', '=', player)
        .orderBy('u.activity_id', 'desc')
        .limit(100),
    );
  }

  retry(player: number) {
    this.executor.run(
      query
        .updateTable('activity_upload')
        .set({ state: 'pending' })
        .where('state', '=', 'failed')
        .where(
          'activity_id',
          'in',
          query.selectFrom('activity_completion').select('activity_id').where('player_id', '=', player),
        ),
    );
  }

  failInterrupted() {
    this.executor.run(query.updateTable('activity_upload').set({ state: 'failed' }).where('state', '=', 'sending'));
  }

  pending() {
    return this.executor.all(
      this.jobs()
        .select(['u.activity_id', 'u.provider'])
        .where('u.state', '=', 'pending')
        .where('c.done', '=', 1)
        .orderBy('u.activity_id')
        .orderBy('u.provider')
        .limit(10),
    );
  }

  ready(activity: number, provider: string) {
    return this.executor.get(
      this.jobs()
        .select(['u.activity_id', 'u.provider', 'c.player_id', 'c.payload'])
        .where('u.activity_id', '=', activity)
        .where('u.provider', '=', provider)
        .where('u.state', '=', 'pending')
        .where('c.done', '=', 1),
    );
  }

  /** Only pending jobs can be claimed; terminal results cannot resurrect deleted jobs. */
  claim(activity: number, provider: string) {
    return this.transition(activity, provider, 'pending', 'sending');
  }

  finish(activity: number, provider: string, state: 'sent' | 'failed' | 'cancelled') {
    return this.transition(activity, provider, 'sending', state);
  }

  private transition(activity: number, provider: string, expected: UploadState, state: UploadState) {
    const result = this.executor.run(
      query
        .updateTable('activity_upload')
        .set({ state })
        .where('activity_id', '=', activity)
        .where('provider', '=', provider)
        .where('state', '=', expected),
    );

    return result.changes !== 0;
  }
}
