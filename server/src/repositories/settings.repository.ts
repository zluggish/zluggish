import { t } from '#src/i18n/index';
import { decodeOverrides, decodePreference } from '#src/dtos/settings.dto';
import type { Overrides, Preference } from '#src/dtos/settings.dto';

import { ApplicationError } from '#src/errors';
import { sql } from 'kysely';
import { ConfigError } from '#src/config/index';
import { riderSettingsSchema } from '#src/config/schema';
import { query, SqliteExecutor } from '#src/db/query';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Schema } from 'effect';

const decodeRow = Schema.decodeUnknownSync(Schema.Struct({ value: Schema.String }));

const decodeJsonRecord = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)));

const decodeRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));

type Json = typeof Schema.Json.Type;

export class SettingsStore {
  private readonly executor: SqliteExecutor;

  private readonly versioned: boolean;

  // Read-through caches. This store is the only writer while the server holds the
  // storage lock, so each committed change updates or invalidates its entry.
  private readonly riders = new Map<number, Overrides>();

  private readonly worlds = new Map<string, Record<string, Json>>();

  /** Settings live in the main database. The store does not close a shared connection. */
  constructor(
    readonly db: DatabaseSync,
    private readonly owned = false,
  ) {
    this.executor = new SqliteExecutor(db);
    this.versioned = db
      .prepare('PRAGMA table_info(rider_settings)')
      .all()
      .some((row) => row.name === 'revision');
  }

  /** settings.db from before version 6. Offline upgrades write it; the storage
  migration merges it into the main database.
  */
  static legacy(storage: string, readOnly = false) {
    const path = resolve(storage, 'settings.db');

    if (readOnly && !existsSync(path)) {
      throw new ConfigError(t('settings_storage_uninitialized'));
    }

    if (!readOnly) {
      mkdirSync(storage, { recursive: true });
    }

    const db = new DatabaseSync(path, { readOnly, timeout: 5000 });

    const version = Schema.decodeUnknownSync(Schema.Struct({ user_version: Schema.Number }))(
      db.prepare('PRAGMA user_version').get(),
    ).user_version;

    if (version > 1 || (readOnly && version !== 1)) {
      db.close();
      throw new ConfigError(t('unsupported_settings_database_version'));
    }

    if (!readOnly) {
      db.exec(`PRAGMA synchronous=FULL;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS rider_settings (player_id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS config_migration (id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS world_settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        PRAGMA user_version=1;
        COMMIT;`);
    }

    return new SettingsStore(db, true);
  }

  /** Offline tools: the main database after version 6, otherwise settings.db. */
  static open(storage: string) {
    return SettingsStore.openMerged(storage, false) ?? SettingsStore.legacy(storage);
  }

  /** Read-only offline access; null when no settings were ever saved. */
  static openReadOnly(storage: string) {
    return (
      SettingsStore.openMerged(storage, true) ??
      (existsSync(resolve(storage, 'settings.db')) ? SettingsStore.legacy(storage, true) : null)
    );
  }

  private static openMerged(storage: string, readOnly: boolean) {
    const main = resolve(storage, 'zluggish.db');

    if (existsSync(main)) {
      const db = new DatabaseSync(main, { readOnly, timeout: 5000 });

      try {
        const merged = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rider_document'").get();

        if (merged) {
          if (!readOnly) {
            db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
          }

          return new SettingsStore(db, true);
        }
      } catch (error) {
        db.close();
        throw error;
      }

      db.close();
    }

    return null;
  }

  has(playerId: number) {
    return !!this.executor.get(
      query.selectFrom('rider_settings').select('player_id').where('player_id', '=', playerId),
    );
  }

  read(playerId: number): Overrides {
    const cached = this.riders.get(playerId);

    if (cached) {
      return { ...cached };
    }
    const row = this.executor.get(query.selectFrom('rider_settings').select('value').where('player_id', '=', playerId));
    const overrides = row ? decodeOverrides(JSON.parse(decodeRow(row).value)) : {};

    if (!this.db.isTransaction) {
      this.riders.set(playerId, overrides);
    }

    return { ...overrides };
  }

  revision(playerId: number) {
    return (
      this.executor.get(query.selectFrom('rider_settings').select('revision').where('player_id', '=', playerId))
        ?.revision ?? 0
    );
  }

  worldRevision(id: string) {
    return this.executor.get(query.selectFrom('world_settings').select('revision').where('id', '=', id))?.revision ?? 0;
  }

  save(playerId: number, overrides: Overrides, expected = this.versioned ? this.revision(playerId) : undefined) {
    if (expected !== undefined && this.revision(playerId) !== expected) {
      throw new ApplicationError({
        status: 409,
        message: t('settings_settings_conflict'),
      });
    }
    const candidate = decodePreference({ playerId, overrides });
    const value = JSON.stringify(candidate.overrides);
    this.executor.run(
      query
        .insertInto('rider_settings')
        .values({ player_id: candidate.playerId, value })
        .onConflict((conflict) =>
          conflict
            .column('player_id')
            .doUpdateSet({ value, ...(this.versioned && { revision: sql`rider_settings.revision + 1` }) }),
        ),
    );

    if (this.db.isTransaction) {
      this.riders.delete(candidate.playerId);
    } else {
      this.riders.set(candidate.playerId, candidate.overrides);
    }
  }

  import(id: string, preferences: ReadonlyArray<Preference>) {
    this.riders.clear();
    this.db.exec('BEGIN IMMEDIATE');

    try {
      if (!this.executor.get(query.selectFrom('config_migration').select('id').where('id', '=', id))) {
        for (const preference of preferences) {
          const row = this.executor.get(
            query.selectFrom('rider_settings').select('value').where('player_id', '=', preference.playerId),
          );

          if (row && JSON.stringify(this.read(preference.playerId)) !== JSON.stringify(preference.overrides)) {
            throw new ConfigError(t('settings_preferences_conflict', { value1: preference.playerId }));
          }

          this.save(preference.playerId, preference.overrides);
        }

        this.executor.run(query.insertInto('config_migration').values({ id }));
      }

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.riders.clear();
    }
  }

  world(id: string) {
    const cached = this.worlds.get(id);

    if (cached) {
      return structuredClone(cached);
    }

    const row = this.executor.get(query.selectFrom('world_settings').select('value').where('id', '=', id));
    const value = row ? decodeJsonRecord(decodeRow(row).value) : {};

    if (!this.db.isTransaction) {
      this.worlds.set(id, value);
    }

    return structuredClone(value);
  }

  worldIds() {
    return this.executor
      .all(query.selectFrom('world_settings').select('id').orderBy('id'))
      .map((row) => Schema.decodeUnknownSync(Schema.String)(row.id));
  }

  saveWorld(id: string, value: Record<string, Json>, expected = this.versioned ? this.worldRevision(id) : undefined) {
    if (expected !== undefined && this.worldRevision(id) !== expected) {
      throw new ApplicationError({
        status: 409,
        message: t('settings_settings_conflict'),
      });
    }
    const checked = decodeRecord(value);
    const serialized = JSON.stringify(checked);
    this.executor.run(
      query
        .insertInto('world_settings')
        .values({ id, value: serialized })
        .onConflict((conflict) =>
          conflict
            .column('id')
            .doUpdateSet({ value: serialized, ...(this.versioned && { revision: sql`world_settings.revision + 1` }) }),
        ),
    );

    if (this.db.isTransaction) {
      this.worlds.delete(id);
    } else {
      this.worlds.set(id, structuredClone(checked));
    }
  }

  resetWorld(id: string) {
    this.saveWorld(id, {});
    this.worlds.delete(id);
  }

  close() {
    if (this.owned && this.db.isOpen) {
      this.db.close();
    }
  }
}

export const defaultRiderSettings = Schema.decodeUnknownSync(riderSettingsSchema)({});

export class RiderRepository {
  checkRider(storage: string, playerId: number) {
    const path = resolve(storage, 'zluggish.db');

    if (!existsSync(path)) {
      throw new ConfigError(t('settings_rider_account_missing'));
    }
    const db = new DatabaseSync(path, { readOnly: true });

    try {
      if (!new SqliteExecutor(db).get(query.selectFrom('user').select('player_id').where('player_id', '=', playerId))) {
        throw new ConfigError(t('unknown_rider'));
      }
    } finally {
      db.close();
    }
  }
}
