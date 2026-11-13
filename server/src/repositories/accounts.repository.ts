import { completionSchemaSQL } from '#src/repositories/completion.repository';
import { ConfigError } from '#src/config/index';
import { hashPassword, verifyPassword } from '#src/repositories/password.repository';
import { createSchemaSQL } from '#src/repositories/schema.repository';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

export class Accounts {
  readonly db: DatabaseSync;

  constructor(readonly storage: string) {
    const path = resolve(storage, 'zluggish.db');
    const legacyPath = resolve(storage, 'zwift-offline.db');
    const existingPath = existsSync(path) ? path : legacyPath;
    const fresh = !existsSync(existingPath);

    if (!fresh) {
      const inspection = new DatabaseSync(existingPath, { readOnly: true });

      try {
        const version = z
          .object({ version: z.number() })
          .safeParse(inspection.prepare('SELECT version FROM version LIMIT 1').get());

        const columns = new Set(
          inspection
            .prepare('PRAGMA table_info(user)')
            .all()
            .map((row) => row.name),
        );

        if (
          !version.success ||
          version.data.version !== 4 ||
          !columns.has('auth_version') ||
          !columns.has('official_player_id') ||
          !inspection.prepare("SELECT 1 FROM sqlite_master WHERE name='account_state'").get()
        )
          throw new ConfigError('Account database upgrade required; run accounts migrate while stopped');
      } finally {
        inspection.close();
      }
    } else if (existsSync(storage) && readdirSync(storage).some((name) => /^\d+$/.test(name))) {
      throw new ConfigError('Legacy rider folders require accounts migrate; refusing to create new identities');
    }

    if (!fresh && existingPath !== path) {
      const source = new DatabaseSync(existingPath);

      try {
        source.exec('PRAGMA journal_mode=DELETE');
      } finally {
        source.close();
      }

      renameSync(existingPath, path);
    }

    mkdirSync(storage, { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');

    if (fresh) {
      this.db.exec(`BEGIN IMMEDIATE; ${createSchemaSQL}
        INSERT INTO version VALUES (4); INSERT INTO account_state VALUES (1, 0); COMMIT;`);
    }

    this.db.exec(completionSchemaSQL);
  }

  list(): Rider[] {
    return this.db
      .prepare(
        'SELECT player_id,username,first_name,last_name,pass_hash,auth_version,CAST(official_player_id AS TEXT) AS official_player_id,is_admin FROM user ORDER BY lower(first_name), lower(last_name), player_id',
      )
      .all()
      .map((row) => riderSchema.parse(row));
  }

  get(id: number): Rider | null {
    const row = this.db
      .prepare(
        'SELECT player_id,username,first_name,last_name,pass_hash,auth_version,CAST(official_player_id AS TEXT) AS official_player_id,is_admin FROM user WHERE player_id=?',
      )
      .get(id);

    return row ? riderSchema.parse(row) : null;
  }

  byUsername(username: string): Rider | null {
    const row = this.db
      .prepare(
        'SELECT player_id,username,first_name,last_name,pass_hash,auth_version,CAST(official_player_id AS TEXT) AS official_player_id,is_admin FROM user WHERE username=?',
      )
      .get(username);

    return row ? riderSchema.parse(row) : null;
  }

  identity(identity: string): Rider | null {
    if (!/^\d+:\d+$/.test(identity)) return null;
    const [id = 0, version] = identity.split(':').map(Number);
    const rider = this.get(id);

    return rider && rider.auth_version === version ? rider : null;
  }

  setupComplete() {
    return (
      z
        .object({ setup_complete: z.number() })
        .parse(this.db.prepare('SELECT setup_complete FROM account_state WHERE id=1').get()).setup_complete !== 0
    );
  }

  async create(name: string, password: string, owner = false, username?: string): Promise<Rider> {
    const displayName = name.trim();

    if (!displayName || displayName.length > 100) throw new ConfigError('Enter a name between 1 and 100 characters');
    const passwordHash = password ? await hashPassword(password) : null;
    let created: string | null = null;
    this.db.exec('BEGIN IMMEDIATE');

    try {
      if (owner && this.setupComplete()) throw new ConfigError('Setup already completed');

      const occupied = [
        ...this.list().map((user) => user.player_id),
        ...readdirSync(this.storage)
          .filter((name) => /^\d+$/.test(name))
          .map(Number),
      ];

      const id = Math.max(0, ...occupied) + 1;

      if (!Number.isSafeInteger(id) || id > 2_147_483_647) throw new ConfigError('Rider ID space exhausted');
      const folder = resolve(this.storage, String(id));
      mkdirSync(folder);
      created = folder;
      const [first = '', ...rest] = displayName.split(/\s+/);
      this.db
        .prepare(
          `INSERT INTO user (player_id,username,first_name,last_name,pass_hash,auth_version,official_player_id,enable_ghosts,is_admin,remember)
        VALUES (?,?,?,?,?,1,NULL,1,?,0)`,
        )
        .run(
          id,
          username ?? `rider-${randomBytes(12).toString('hex')}@local.invalid`,
          first,
          rest.join(' '),
          passwordHash,
          owner ? 1 : 0,
        );

      if (owner) this.db.exec('UPDATE account_state SET setup_complete=1 WHERE id=1');

      this.db.exec('COMMIT');
      const user = this.get(id);

      if (!user) throw new Error('Created rider unavailable');

      return user;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');

      if (created) rmSync(created, { recursive: true, force: true });

      throw error;
    }
  }

  async verify(rider: Rider, password: string) {
    const valid = await verifyPassword(rider.pass_hash, password);

    if (valid && rider.pass_hash?.startsWith('sha256$')) {
      const upgraded = await hashPassword(password);
      this.db
        .prepare('UPDATE user SET pass_hash=? WHERE player_id=? AND pass_hash=?')
        .run(upgraded, rider.player_id, rider.pass_hash);
    }

    return valid;
  }

  async changePassword(id: number, password: string | null, admin = false) {
    const hash = password ? await hashPassword(password) : null;
    this.db
      .prepare(
        'UPDATE user SET pass_hash=?, auth_version=auth_version+1, is_admin=CASE WHEN ? THEN 1 ELSE is_admin END WHERE player_id=?',
      )
      .run(hash, admin ? 1 : 0, id);
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }
}

export function identityOf(rider: Rider) {
  return `${rider.player_id}:${rider.auth_version}`;
}
