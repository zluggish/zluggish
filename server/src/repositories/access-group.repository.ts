import { query, SqliteExecutor } from '#src/db/query';
import { atomic } from '#src/db/transaction';
import type { DatabaseSync } from 'node:sqlite';
import { Schema } from 'effect';

const group = Schema.Struct({ id: Schema.Int, name: Schema.String });

const email = Schema.Struct({ group_id: Schema.Int, email: Schema.String });

const rider = Schema.Struct({ group_id: Schema.Int, player_id: Schema.Int });

const seen = Schema.Struct({ email: Schema.String, last_seen: Schema.Int });

export type AccessGroupRow = typeof group.Type;

/** How many unmatched emails the "waiting for a group" list keeps. */
const SEEN_LIMIT = 50;

/** Launcher access groups: which Cloudflare emails see which riders in the launcher picker.
Emails are stored lowercased; the columns also compare without case.
*/
export class AccessGroupsRepository {
  private readonly executor: SqliteExecutor;

  constructor(private readonly db: DatabaseSync) {
    this.executor = new SqliteExecutor(db);
  }

  groups() {
    return this.executor
      .all(query.selectFrom('access_group').select(['id', 'name']).orderBy('name').orderBy('id'))
      .map((found) => Schema.decodeUnknownSync(group)(found));
  }

  group(id: number) {
    const found = this.executor.get(query.selectFrom('access_group').select(['id', 'name']).where('id', '=', id));

    return found ? Schema.decodeUnknownSync(group)(found) : null;
  }

  emails() {
    return this.executor
      .all(query.selectFrom('access_group_email').select(['group_id', 'email']).orderBy('email'))
      .map((found) => Schema.decodeUnknownSync(email)(found));
  }

  members() {
    return this.executor
      .all(query.selectFrom('access_group_rider').select(['group_id', 'player_id']))
      .map((found) => Schema.decodeUnknownSync(rider)(found));
  }

  /** The riders in every group that lists `address`. */
  ridersFor(address: string) {
    return this.executor
      .all(
        query
          .selectFrom('access_group_rider')
          .innerJoin('access_group_email', 'access_group_email.group_id', 'access_group_rider.group_id')
          .select('access_group_rider.player_id')
          .distinct()
          .where('access_group_email.email', '=', address),
      )
      .map((found) => Schema.decodeUnknownSync(Schema.Int)(found.player_id));
  }

  create(name: string) {
    return Number(this.executor.run(query.insertInto('access_group').values({ name })).lastInsertRowid);
  }

  rename(id: number, name: string) {
    return this.executor.run(query.updateTable('access_group').set({ name }).where('id', '=', id)).changes > 0;
  }

  delete(id: number) {
    return this.executor.run(query.deleteFrom('access_group').where('id', '=', id)).changes > 0;
  }

  addEmail(id: number, address: string) {
    this.executor.run(
      query
        .insertInto('access_group_email')
        .values({ group_id: id, email: address })
        .onConflict((conflict) => conflict.doNothing()),
    );
  }

  removeEmail(id: number, address: string) {
    this.executor.run(query.deleteFrom('access_group_email').where('group_id', '=', id).where('email', '=', address));
  }

  addRider(id: number, player: number) {
    this.executor.run(
      query
        .insertInto('access_group_rider')
        .values({ group_id: id, player_id: player })
        .onConflict((conflict) => conflict.doNothing()),
    );
  }

  removeRider(id: number, player: number) {
    this.executor.run(
      query.deleteFrom('access_group_rider').where('group_id', '=', id).where('player_id', '=', player),
    );
  }

  /** Remember an email that reached the picker without riders; only the most recent ones are kept. */
  recordSeen(address: string, now: number) {
    atomic(this.db, () => {
      this.executor.run(
        query
          .insertInto('access_seen')
          .values({ email: address, last_seen: now })
          .onConflict((conflict) => conflict.column('email').doUpdateSet({ last_seen: now })),
      );
      this.executor.run(
        query
          .deleteFrom('access_seen')
          .where(
            'email',
            'not in',
            query.selectFrom('access_seen').select('email').orderBy('last_seen', 'desc').limit(SEEN_LIMIT),
          ),
      );
    });
  }

  forgetSeen(address: string) {
    this.executor.run(query.deleteFrom('access_seen').where('email', '=', address));
  }

  seen() {
    return this.executor
      .all(query.selectFrom('access_seen').select(['email', 'last_seen']).orderBy('last_seen', 'desc'))
      .map((found) => Schema.decodeUnknownSync(seen)(found));
  }
}
