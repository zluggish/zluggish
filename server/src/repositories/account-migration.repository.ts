import { ConfigError } from '#src/config/index';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import { createSchemaSQL } from '#src/repositories/schema.repository';
import { fromBinary } from '@bufbuild/protobuf';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export async function migrateAccounts(storage: string, soloPlayer?: number) {
  const destination = resolve(storage, 'zluggish.db');
  const legacyPath = resolve(storage, 'zwift-offline.db');
  const path = existsSync(destination) || !existsSync(legacyPath) ? destination : legacyPath;
  const fresh = !existsSync(path);
  const db = new DatabaseSync(path);

  try {
    if (!fresh) await backup(db, `${path}.accounts-${Date.now()}.bak`);

    const versionTable = db.prepare("SELECT 1 FROM sqlite_master WHERE name='version'").get();

    if (versionTable) {
      const version = z
        .object({ version: z.number() })
        .parse(db.prepare('SELECT version FROM version LIMIT 1').get()).version;

      if (version > 4 || version < 3)
        throw new ConfigError('Unsupported activity database version; migrate with the original release first');
    }

    db.exec('BEGIN IMMEDIATE');

    const userTable = z
      .object({ sql: z.string() })
      .safeParse(db.prepare("SELECT sql FROM sqlite_master WHERE name='user'").get());

    if (userTable.success) {
      const columns = db.prepare('PRAGMA table_info(user)').all();
      const names = new Set(columns.map((row) => z.string().parse(row.name)));
      const password = columns.find((row) => row.name === 'pass_hash');

      if (password?.notnull) {
        const definition = userTable.data.sql
          .replace(/CREATE TABLE\s+(?:"user"|user)/i, 'CREATE TABLE user_accounts_new')
          .replace(/(pass_hash\s+\w+)\s+NOT NULL/i, '$1');

        const indexes = db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE tbl_name='user' AND type IN ('index','trigger') AND sql IS NOT NULL",
          )
          .all();

        db.exec(definition);
        db.exec(
          `INSERT INTO user_accounts_new SELECT * FROM user; DROP TABLE user; ALTER TABLE user_accounts_new RENAME TO user;`,
        );

        for (const index of indexes) db.exec(z.string().parse(index.sql));
      }

      for (const [name, sql] of Object.entries({
        auth_version: 'ALTER TABLE user ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1',
        official_player_id: 'ALTER TABLE user ADD COLUMN official_player_id INTEGER',
        is_admin: 'ALTER TABLE user ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0',
      })) {
        if (!names.has(name)) db.exec(sql);
      }
    }

    db.exec(createSchemaSQL);
    // Legacy passwords are intentionally discarded. Keep current hashes on reruns
    // and revoke sessions belonging to riders whose password protection changed.
    db.exec(
      "UPDATE user SET pass_hash=NULL, auth_version=auth_version+1 WHERE pass_hash IS NOT NULL AND pass_hash NOT LIKE '$argon2id$%'",
    );
    const users = db.prepare('SELECT player_id FROM user').all();

    const profiles = readdirSync(storage)
      .filter((name) => /^\d+$/.test(name) && existsSync(resolve(storage, name, 'profile.bin')))
      .map(Number);

    const ids = new Set(users.map((row) => Number(row.player_id)));
    const orphans = profiles.filter((id) => !ids.has(id));

    const selected = soloPlayer ?? (users.length === 0 && profiles.length === 1 ? profiles[0] : undefined);

    if (orphans.length > 0 && selected === undefined)
      throw new ConfigError('Ambiguous legacy riders; select --solo-player ID explicitly');

    if (selected !== undefined) {
      if (!profiles.includes(selected)) throw new ConfigError('Selected legacy profile is missing');

      const profile = fromBinary(PlayerProfileSchema, readFileSync(resolve(storage, String(selected), 'profile.bin')));

      if (!profile.firstName.trim()) throw new ConfigError('Legacy profile has no name');

      if (!ids.has(selected))
        db.prepare(
          `INSERT INTO user (player_id,username,first_name,last_name,pass_hash,auth_version,is_admin,enable_ghosts,remember) VALUES (?,?,?,?,NULL,1,?,1,0)`,
        ).run(
          selected,
          `rider-${randomBytes(12).toString('hex')}@local.invalid`,
          profile.firstName,
          profile.lastName,
          users.length > 0 ? 0 : 1,
        );
    }

    if (!db.prepare('SELECT 1 FROM user WHERE is_admin=1').get())
      db.prepare('UPDATE user SET is_admin=1 WHERE player_id=(SELECT MIN(player_id) FROM user)').run();

    db.prepare('INSERT OR IGNORE INTO account_state VALUES (1, ?)').run(
      db.prepare('SELECT 1 FROM user LIMIT 1').get() ? 1 : 0,
    );
    db.exec('DELETE FROM version; INSERT INTO version VALUES (4); COMMIT;');

    if (path !== destination) db.exec('PRAGMA journal_mode=DELETE');
    db.close();

    if (path !== destination) renameSync(path, destination);
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    if (db.isOpen) db.close();
  }
}
