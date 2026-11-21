import type { UploadState } from '#src/enum';
import { query, SqliteExecutor } from '#src/db/query';
import type { DatabaseSync } from 'node:sqlite';
import { Schema } from 'effect';

const delivery = Schema.Struct({
  activity_id: Schema.Finite,
  provider: Schema.String,
  state: Schema.String,
  attempt: Schema.NullOr(Schema.String),
  remote_id: Schema.NullOr(Schema.String),
  step: Schema.NullOr(Schema.String),
  last_error: Schema.NullOr(Schema.String),
});

export type Delivery = (typeof delivery)['Type'];

const remoteIdRow = Schema.Struct({
  activity_id: Schema.Finite,
  provider: Schema.String,
  remote_id: Schema.String,
});

/** Delivery records, separate from completion. pending -> sending (attempt token) ->
sent | failed | ambiguous; pending | failed | ambiguous -> cancelled. Only the attempt
that committed sending records its result. Records outlive their jobs.
*/
export class UploadsRepository {
  private readonly executor: SqliteExecutor;

  constructor(
    db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    this.executor = new SqliteExecutor(db);
  }

  status(player: number) {
    return this.executor.all(
      query
        .selectFrom('activity_upload as u')
        .innerJoin('activity as a', 'a.id', 'u.activity_id')
        .select(['u.activity_id', 'u.provider', 'u.state', 'u.last_error'])
        .where('a.player_id', '=', player)
        .orderBy('u.activity_id', 'desc')
        .limit(100),
    );
  }

  /** Deliveries that wait for a send or a decision, for operator review during an upload pause. */
  waiting() {
    return this.executor.all(
      query
        .selectFrom('activity_upload')
        .select(['activity_id', 'provider', 'state'])
        .where('state', 'in', ['pending', 'sending', 'ambiguous'])
        .orderBy('activity_id')
        .orderBy('provider'),
    );
  }

  insert(activity: number | bigint, provider: string) {
    return (
      this.executor.run(
        query
          .insertInto('activity_upload')
          .values({ activity_id: activity, provider, updated_at: this.now() })
          .onConflict((conflict) => conflict.doNothing()),
      ).changes !== 0
    );
  }

  get(activity: number, provider: string): Delivery | null {
    const row = this.executor.get(
      query
        .selectFrom('activity_upload')
        .select(['activity_id', 'provider', 'state', 'attempt', 'remote_id', 'step', 'last_error'])
        .where('activity_id', '=', activity)
        .where('provider', '=', provider),
    );

    return row ? Schema.decodeUnknownSync(delivery)(row) : null;
  }

  /** Commit sending before the provider request. */
  begin(activity: number, provider: string, attempt: string) {
    return this.update(activity, provider, ['pending'], { state: 'sending', attempt, last_error: null });
  }

  /** A send that may have reached the provider, with no known result. */
  abandon(activity: number, provider: string) {
    return this.update(activity, provider, ['sending'], { state: 'ambiguous', last_error: 'interrupted' });
  }

  /** Record the outcome of this attempt. A confirmed result also resolves an attempt that
  another handler marked ambiguous after the lease expired.
  */
  record(
    activity: number,
    provider: string,
    attempt: string,
    state: 'sent' | 'failed' | 'ambiguous',
    error: string | null,
  ) {
    return (
      this.executor.run(
        query
          .updateTable('activity_upload')
          .set({ state, last_error: error, updated_at: this.now() })
          .where('activity_id', '=', activity)
          .where('provider', '=', provider)
          .where('attempt', '=', attempt)
          .where('state', 'in', ['sending', 'ambiguous']),
      ).changes !== 0
    );
  }

  /** Persist a confirmed step of a multi-request delivery before the next request. */
  progress(activity: number, provider: string, attempt: string, step: string, remoteId: string) {
    return (
      this.executor.run(
        query
          .updateTable('activity_upload')
          .set({ step, remote_id: remoteId, updated_at: this.now() })
          .where('activity_id', '=', activity)
          .where('provider', '=', provider)
          .where('attempt', '=', attempt)
          .where('state', '=', 'sending'),
      ).changes !== 0
    );
  }

  /** Remember the id of the activity the provider created, before the delivery is recorded as sent. */
  setRemote(activity: number | bigint, provider: string, attempt: string, remoteId: string): boolean {
    return (
      this.executor.run(
        query
          .updateTable('activity_upload')
          .set({ remote_id: remoteId, updated_at: this.now() })
          .where('activity_id', '=', activity)
          .where('provider', '=', provider)
          .where('attempt', '=', attempt)
          .where('state', '=', 'sending'),
      ).changes !== 0
    );
  }

  /** Remote ids of sent deliveries for the given activities belonging to the player. */
  remoteIds(
    activities: Array<number>,
    player: number,
  ): Array<{ activity_id: number; provider: string; remote_id: string }> {
    if (activities.length === 0) {
      return [];
    }

    const rows = this.executor.all(
      query
        .selectFrom('activity_upload as u')
        .innerJoin('activity as a', 'a.id', 'u.activity_id')
        .select(['u.activity_id', 'u.provider', 'u.remote_id'])
        .where('a.player_id', '=', player)
        .where('u.activity_id', 'in', activities)
        .where('u.state', '=', 'sent')
        .where('u.remote_id', 'is not', null),
    );

    return rows.map((row) => Schema.decodeUnknownSync(remoteIdRow)(row));
  }

  /** Old confirmed or cancelled deliveries. Failed and ambiguous ones wait for a decision. */
  private finished(before: number) {
    return query
      .deleteFrom('activity_upload')
      .where('state', 'in', ['sent', 'cancelled'])
      .where('updated_at', '<', before);
  }

  prunable(before: number) {
    return this.executor.all(
      query
        .selectFrom('activity_upload')
        .select('activity_id')
        .where('state', 'in', ['sent', 'cancelled'])
        .where('updated_at', '<', before),
    ).length;
  }

  prune(before: number) {
    return this.executor.run(this.finished(before)).changes;
  }

  /** A rider's deliveries that wait for a send. */
  pendingFor(player: number) {
    return this.executor.all(
      query
        .selectFrom('activity_upload as u')
        .innerJoin('activity as a', 'a.id', 'u.activity_id')
        .select(['u.activity_id', 'u.provider'])
        .where('a.player_id', '=', player)
        .where('u.state', '=', 'pending'),
    );
  }

  cancel(activity: number, provider: string) {
    return this.update(activity, provider, ['pending', 'failed', 'ambiguous'], { state: 'cancelled' });
  }

  /** A rider's request to upload again. A delivery that was sent starts over, so a multi-request
  provider creates a new remote activity instead of updating the earlier one.
  */
  requeue(activity: number, provider: string, from: UploadState) {
    return (
      this.executor.run(
        query
          .updateTable('activity_upload')
          .set({
            state: 'pending',
            last_error: null,
            ...(from === 'sent' && { remote_id: null, step: null }),
            updated_at: this.now(),
          })
          .where('activity_id', '=', activity)
          .where('provider', '=', provider)
          .where('state', '=', from),
      ).changes !== 0
    );
  }

  /** At startup no request is in flight: an earlier send has an unknown result. */
  interrupted() {
    return this.executor.run(
      query
        .updateTable('activity_upload')
        .set({ state: 'ambiguous', last_error: 'interrupted', updated_at: this.now() })
        .where('state', '=', 'sending'),
    ).changes;
  }

  /** Failed deliveries, and ambiguous ones only on explicit request, become pending. */
  retry(player: number, ambiguous: boolean) {
    const states: Array<UploadState> = ambiguous ? ['failed', 'ambiguous'] : ['failed'];

    const rows = this.executor.all(
      query
        .selectFrom('activity_upload as u')
        .innerJoin('activity as a', 'a.id', 'u.activity_id')
        .select(['u.activity_id', 'u.provider'])
        .where('a.player_id', '=', player)
        .where('u.state', 'in', states),
    );

    for (const row of rows) {
      this.update(row.activity_id, row.provider, states, { state: 'pending' });
    }

    return rows.map((row) => ({ activity: row.activity_id, provider: row.provider }));
  }

  private update(
    activity: number,
    provider: string,
    from: Array<UploadState>,
    values: { state: UploadState; attempt?: string; last_error?: string | null },
  ) {
    return (
      this.executor.run(
        query
          .updateTable('activity_upload')
          .set({ ...values, updated_at: this.now() })
          .where('activity_id', '=', activity)
          .where('provider', '=', provider)
          .where('state', 'in', from),
      ).changes !== 0
    );
  }
}
