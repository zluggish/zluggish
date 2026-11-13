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
  setState(
    activity: number,
    provider: string,
    state: 'sending' | 'cancelled' | 'sent' | 'failed',
    expected?: 'sending',
  ) {
    let update = query
      .updateTable('activity_upload')
      .set({ state })
      .where('activity_id', '=', activity)
      .where('provider', '=', provider);

    if (expected) update = update.where('state', '=', expected);
    this.executor.run(update);
  }
}
