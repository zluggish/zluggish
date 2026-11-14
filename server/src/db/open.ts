import { removeLegacyAccountFields } from '#src/db/account-upgrade';
import { ConfigError } from '#src/config/index';
import { completionSchemaSQL, createSchemaSQL } from '#src/db/ddl';
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

/** Absent -> fresh v5; compatible v4 -> transactionally upgraded v5; v5 -> open.
Incompatible schema/hash/folder evidence requires explicit account migration.
Filename publication is separate from the schema transaction; neither invents identities.
*/
export function openDatabase(storage: string): DatabaseSync {
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
        ![4, 5].includes(version.data.version) ||
        !columns.has('auth_version') ||
        !columns.has('official_player_id') ||
        !!inspection
          .prepare("SELECT 1 FROM user WHERE pass_hash IS NOT NULL AND pass_hash NOT LIKE '$argon2id$%' LIMIT 1")
          .get() ||
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
  const db = new DatabaseSync(path, { timeout: 5000 });

  try {
    db.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');

    if (fresh) {
      db.exec('BEGIN IMMEDIATE');
      db.exec(createSchemaSQL);
      db.exec('INSERT INTO version VALUES (5); INSERT INTO account_state VALUES (1, 0); COMMIT;');
    }

    const version = z.object({ version: z.number() }).parse(db.prepare('SELECT version FROM version LIMIT 1').get());

    if (version.version === 4) {
      db.exec('BEGIN IMMEDIATE');
      removeLegacyAccountFields(db, storage);

      db.exec('DELETE FROM version; INSERT INTO version VALUES (5); COMMIT;');
    }

    db.exec(completionSchemaSQL);

    return db;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
    throw error;
  }
}
