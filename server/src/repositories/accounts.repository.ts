import { t } from '#src/i18n/index';
import { normalizeLoginName } from '#src/dtos/management.dto';
import { atomic } from '#src/db/transaction';
import { integer } from '#src/db/values';
import type { IntegerInput } from '#src/db/values';
import { query, SqliteExecutor } from '#src/db/query';
import type { Database } from '#src/db/schema';
import { sql } from 'kysely';
import type { Insertable } from 'kysely';
import type { DatabaseSync } from 'node:sqlite';
import { Schema } from 'effect';

export const riderSchema = Schema.Struct({
  player_id: Schema.Int.check(Schema.isGreaterThan(0)),
  username: Schema.String,
  first_name: Schema.String,
  last_name: Schema.String,
  pass_hash: Schema.NullOr(Schema.String),
  auth_version: Schema.Int,
  official_player_id: Schema.NullOr(Schema.String),
  role: Schema.Literals(['rider', 'administrator']),
  enabled: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
});

export type User = (typeof riderSchema)['Type'];

export class AccountsRepository {
  private readonly executor: SqliteExecutor;

  constructor(private readonly db: DatabaseSync) {
    this.executor = new SqliteExecutor(db);
  }

  private selection() {
    return query
      .selectFrom('user')
      .select([
        'player_id',
        'username',
        'first_name',
        'last_name',
        'pass_hash',
        'auth_version',
        'role',
        'enabled',
        'revision',
        sql<string | null>`cast(official_player_id as text)`.as('official_player_id'),
      ]);
  }

  list(): Array<User> {
    return this.executor
      .all(
        this.selection()
          .orderBy(sql`lower(first_name)`)
          .orderBy(sql`lower(last_name)`)
          .orderBy('player_id'),
      )
      .map((row) => Schema.decodeUnknownSync(riderSchema)(row));
  }

  get(id: number): User | null {
    const row = this.executor.get(this.selection().where('player_id', '=', id));

    return row ? Schema.decodeUnknownSync(riderSchema)(row) : null;
  }

  /** SQLite lower() folds only ASCII, so imported names compare in JavaScript after
  normalizeLoginName. Two imported names that normalize alike match only exactly.
  */
  byUsername(username: string): User | null {
    const exact = this.executor.get(this.selection().where('username', '=', username));

    if (exact) {
      return Schema.decodeUnknownSync(riderSchema)(exact);
    }
    const matches = this.sameLoginName(username);

    return matches.length === 1 ? (matches[0] ?? null) : null;
  }

  sameLoginName(username: string) {
    const wanted = normalizeLoginName(username);

    return this.list().filter((rider) => normalizeLoginName(rider.username) === wanted);
  }

  insert(rider: Insertable<Database['user']>) {
    return this.executor.run(query.insertInto('user').values(rider));
  }

  // Offline recovery preserves disabled state unless administrator access is requested.
  setPassword(id: number, hash: string | null, admin: boolean) {
    if (!hash) {
      throw new Error(t('password_required'));
    }
    atomic(this.db, () => {
      this.executor.run(
        query
          .updateTable('user')
          .set({
            pass_hash: hash,
            auth_version: sql`auth_version + 1`,
            revision: sql`revision + 1`,
            ...(admin && { role: 'administrator' as const, enabled: 1 }),
          })
          .where('player_id', '=', id),
      );
      this.executor.run(
        query
          .deleteFrom('rider_document')
          .where('player_id', '=', id)
          .where('name', 'in', ['encryption_key.bin', 'relay-auth-version']),
      );

      if (admin) {
        this.executor.run(query.updateTable('web_setup_state').set({ state: 'complete' }).where('id', '=', 1));
      }
    });
  }

  updateImportedProfile(id: number, firstName: string, lastName: string, officialId: IntegerInput | null) {
    this.executor.run(
      query
        .updateTable('user')
        .set({
          revision: sql`revision + 1`,
          first_name: firstName,
          last_name: lastName,
          official_player_id: officialId === null ? null : integer(officialId),
        })
        .where('player_id', '=', id),
    );
  }

  updateName(id: number, firstName: string, lastName: string) {
    this.executor.run(
      query
        .updateTable('user')
        .set({ first_name: firstName, last_name: lastName, revision: sql`revision + 1` })
        .where('player_id', '=', id),
    );
  }
}
