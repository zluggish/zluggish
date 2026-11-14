import { integer } from '#src/db/values';
import type { IntegerInput } from '#src/db/values';
import { query, SqliteExecutor } from '#src/db/query';
import type { Database } from '#src/db/schema';
import { sql } from 'kysely';
import type { Insertable } from 'kysely';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export const riderSchema = z.object({
  player_id: z.number().int().positive().safe(),
  username: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  pass_hash: z.string().nullable(),
  auth_version: z.number().int(),
  official_player_id: z.string().nullable(),
  is_admin: z.number(),
});

export type Rider = z.infer<typeof riderSchema>;

export class AccountsRepository {
  private readonly executor: SqliteExecutor;
  constructor(db: DatabaseSync) {
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
        'is_admin',
        sql<string | null>`cast(official_player_id as text)`.as('official_player_id'),
      ]);
  }
  list(): Rider[] {
    return this.executor
      .all(
        this.selection()
          .orderBy(sql`lower(first_name)`)
          .orderBy(sql`lower(last_name)`)
          .orderBy('player_id'),
      )
      .map((row) => riderSchema.parse(row));
  }
  get(id: number): Rider | null {
    const row = this.executor.get(this.selection().where('player_id', '=', id));

    return row ? riderSchema.parse(row) : null;
  }
  byUsername(username: string): Rider | null {
    const row = this.executor.get(this.selection().where('username', '=', username));

    return row ? riderSchema.parse(row) : null;
  }
  setupComplete() {
    const row = this.executor.get(query.selectFrom('account_state').select('setup_complete').where('id', '=', 1));

    if (!row) throw new Error('Missing account setup state');

    return row.setup_complete !== 0;
  }
  insert(rider: Insertable<Database['user']>) {
    return this.executor.run(query.insertInto('user').values(rider));
  }
  finishSetup() {
    this.executor.run(query.updateTable('account_state').set({ setup_complete: 1 }).where('id', '=', 1));
  }
  // Password change (including removing protection) revokes every older player:version identity.
  setPassword(id: number, hash: string | null, admin: boolean) {
    this.executor.run(
      query
        .updateTable('user')
        .set({
          pass_hash: hash,
          auth_version: sql`auth_version + 1`,
          ...(admin && { is_admin: 1 }),
        })
        .where('player_id', '=', id),
    );
  }
  updateImportedProfile(id: number, firstName: string, lastName: string, officialId: IntegerInput | null) {
    this.executor.run(
      query
        .updateTable('user')
        .set({
          first_name: firstName,
          last_name: lastName,
          official_player_id: officialId === null ? null : integer(officialId),
        })
        .where('player_id', '=', id),
    );
  }

  updateName(id: number, firstName: string, lastName: string) {
    this.executor.run(
      query.updateTable('user').set({ first_name: firstName, last_name: lastName }).where('player_id', '=', id),
    );
  }
}
