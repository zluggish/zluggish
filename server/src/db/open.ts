import { t } from '#src/i18n/index';
import { Schema } from 'effect';
import { removeLegacyAccountFields } from '#src/db/account-upgrade';
import { ConfigError } from '#src/config/index';
import {
  administratorSchemaSQL,
  completionSchemaSQL,
  createSchemaSQL,
  dropManagementAuditSQL,
  indexesSQL,
  storageSchemaSQL,
  webSessionSQL,
} from '#src/db/ddl';
import {
  backupLegacyStorage,
  migrateStorage,
  resolvePendingMigration,
  STORAGE_VERSION,
  StorageFile,
} from '#src/migrations/storage';
import { migrateActivityFolders } from '#src/migrations/activity-folders';
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const isVersionRow = Schema.is(Schema.Struct({ version: Schema.Finite }));

/** Ordinary schema migrations after the storage merge. Each runs in one transaction at
startup. A migration that changes existing data sets `backup`: an existing store is
backed up before it runs.
*/
const migrations: Array<{ version: number; up: (db: DatabaseSync, storage: string) => void; backup?: true }> = [
  { version: 7, up: (db) => db.exec(indexesSQL) },
  { version: 8, up: (db) => db.exec(administratorSchemaSQL) },
  { version: 9, up: (db) => db.exec(dropManagementAuditSQL) },
  { version: 10, up: (db) => db.exec(webSessionSQL) },
  { version: 11, up: migrateActivityFolders, backup: true },
];

export const SCHEMA_VERSION = STORAGE_VERSION + migrations.length;

function version(db: DatabaseSync) {
  return Schema.decodeUnknownSync(Schema.Struct({ version: Schema.Finite }))(
    db.prepare('SELECT version FROM version LIMIT 1').get(),
  ).version;
}

/** Per connection: WAL, full durability, foreign keys. An acknowledged save survives a
process crash and a power loss on storage that honors flush requests.
*/
export function configureConnection(db: DatabaseSync) {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
}

/** Absent -> fresh v6; v4 -> v5 in place; v5 or legacy stores -> storage migration to v6
(temporary database, validation, durable publication); v6 -> ordinary migrations.
Incompatible schema/hash/folder evidence requires explicit account migration.
*/
export function openDatabase(storage: string): DatabaseSync {
  if (existsSync(resolve(storage, StorageFile.RestoreMarker))) {
    throw new ConfigError(t('storage_open_restore_incomplete'));
  }

  resolvePendingMigration(storage);

  const path = resolve(storage, 'zluggish.db');
  const legacyPath = resolve(storage, 'zwift-offline.db');
  const existingPath = existsSync(path) ? path : legacyPath;
  const fresh = !existsSync(existingPath);

  let legacyVersion: number | undefined;

  if (!fresh) {
    const inspection = new DatabaseSync(existingPath, { readOnly: true });

    try {
      const row = inspection.prepare('SELECT version FROM version LIMIT 1').get();
      const version = isVersionRow(row) ? row.version : undefined;
      legacyVersion = version;

      const columns = new Set(
        inspection
          .prepare('PRAGMA table_info(user)')
          .all()
          .map((row) => row.name),
      );

      if (version !== undefined && version > SCHEMA_VERSION) {
        throw new ConfigError(t('storage_open_database_version_unsupported'));
      }

      if (
        version === undefined ||
        version < 4 ||
        !columns.has('auth_version') ||
        !columns.has('official_player_id') ||
        !!inspection
          .prepare("SELECT 1 FROM user WHERE pass_hash IS NOT NULL AND pass_hash NOT LIKE '$argon2id$%' LIMIT 1")
          .get() ||
        !inspection.prepare("SELECT 1 FROM sqlite_master WHERE name='account_state'").get()
      ) {
        throw new ConfigError(t('storage_open_accounts_migration_required'));
      }
    } finally {
      inspection.close();
    }
  } else if (existsSync(storage) && readdirSync(storage).some((name) => /^\d+$/.test(name))) {
    throw new ConfigError(t('storage_open_legacy_migration_required'));
  }

  if (legacyVersion === 4 || (!fresh && existingPath !== path)) {
    backupLegacyStorage(storage, 'pre-migration');
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

  // A settings.db from an offline config migration is a legacy store: merge it.
  const legacySettings = existsSync(resolve(storage, StorageFile.Settings));

  if (fresh && legacySettings) {
    backupLegacyStorage(storage, 'pre-migration');
  }

  // Back up an existing v5 store before opening it for writes.
  if (legacyVersion === 5) {
    migrateStorage(storage);
  }

  mkdirSync(storage, { recursive: true });
  let db = new DatabaseSync(path, { timeout: 5000 });

  try {
    db.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');

    if (fresh) {
      db.exec('BEGIN IMMEDIATE');
      db.exec(createSchemaSQL);
      db.exec(completionSchemaSQL);

      if (legacySettings) {
        db.exec('INSERT INTO version VALUES (5)');
      } else {
        db.exec(storageSchemaSQL);
        db.exec(`INSERT INTO version VALUES (${STORAGE_VERSION})`);
      }

      db.exec('INSERT INTO account_state VALUES (1, 0); COMMIT;');
    }

    if (version(db) === 4) {
      db.exec('BEGIN IMMEDIATE');
      removeLegacyAccountFields(db, storage);
      db.exec('DELETE FROM version; INSERT INTO version VALUES (5); COMMIT;');
    }

    if (version(db) === 5) {
      db.close();
      migrateStorage(storage);
      db = new DatabaseSync(path, { timeout: 5000 });
    }

    db.exec(completionSchemaSQL);
    configureConnection(db);

    for (const migration of migrations) {
      if (migration.version <= version(db)) {
        continue;
      }

      if (migration.backup && !fresh) {
        backupLegacyStorage(storage, `storage-v${migration.version}`);
      }
      db.exec('BEGIN IMMEDIATE');
      migration.up(db, storage);
      db.prepare('UPDATE version SET version=?').run(migration.version);
      db.exec('COMMIT');
    }

    return db;
  } catch (error) {
    if (db.isOpen && db.isTransaction) {
      db.exec('ROLLBACK');
    }

    if (db.isOpen) {
      db.close();
    }
    throw error;
  }
}
