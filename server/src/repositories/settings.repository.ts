import { overrideSchema, type Overrides, preferenceSchema, type Preference } from '#src/dtos/settings.dto';

import { ConfigError } from '#src/config/index';
import { riderSettingsSchema } from '#src/config/schema';
import { query, SqliteExecutor } from '#src/db/query';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const rowSchema = z.object({ value: z.string() });

export class SettingsStore {
  readonly db: DatabaseSync;

  private readonly executor: SqliteExecutor;

  constructor(storage: string, readOnly = false) {
    const path = resolve(storage, 'settings.db');

    if (readOnly && !existsSync(path)) throw new ConfigError('No persisted preferences; initialize storage first');

    if (!readOnly) mkdirSync(storage, { recursive: true });

    this.db = new DatabaseSync(path, { readOnly, timeout: 5000 });
    this.executor = new SqliteExecutor(this.db);

    const version = z
      .object({ user_version: z.number() })
      .parse(this.db.prepare('PRAGMA user_version').get()).user_version;

    if (version > 1 || (readOnly && version !== 1)) {
      this.db.close();
      throw new ConfigError('Unsupported settings database version');
    }

    if (!readOnly) {
      this.db.exec(`PRAGMA synchronous=FULL;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS rider_settings (player_id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS config_migration (id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS world_settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        PRAGMA user_version=1;
        COMMIT;`);
    }
  }

  has(playerId: number) {
    return !!this.executor.get(
      query.selectFrom('rider_settings').select('player_id').where('player_id', '=', playerId),
    );
  }

  read(playerId: number): Overrides {
    const row = this.executor.get(query.selectFrom('rider_settings').select('value').where('player_id', '=', playerId));

    if (!row) return {};

    return overrideSchema.parse(JSON.parse(rowSchema.parse(row).value));
  }

  save(playerId: number, overrides: Overrides) {
    const candidate = preferenceSchema.parse({ playerId, overrides });
    const value = JSON.stringify(candidate.overrides);
    this.executor.run(
      query
        .insertInto('rider_settings')
        .values({ player_id: candidate.playerId, value })
        .onConflict((conflict) => conflict.column('player_id').doUpdateSet({ value })),
    );
  }

  import(id: string, preferences: Preference[]) {
    this.db.exec('BEGIN IMMEDIATE');

    try {
      if (!this.executor.get(query.selectFrom('config_migration').select('id').where('id', '=', id))) {
        for (const preference of preferences) {
          const row = this.executor.get(
            query.selectFrom('rider_settings').select('value').where('player_id', '=', preference.playerId),
          );

          if (row && JSON.stringify(this.read(preference.playerId)) !== JSON.stringify(preference.overrides))
            throw new ConfigError(`Conflicting persisted preferences for rider ${preference.playerId}`);

          this.save(preference.playerId, preference.overrides);
        }

        this.executor.run(query.insertInto('config_migration').values({ id }));
      }

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  world(id: string) {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='world_settings'").get()) return {};

    const row = this.executor.get(query.selectFrom('world_settings').select('value').where('id', '=', id));

    return row ? z.record(z.string(), z.json()).parse(JSON.parse(rowSchema.parse(row).value)) : {};
  }

  worldIds() {
    return this.executor
      .all(query.selectFrom('world_settings').select('id').orderBy('id'))
      .map((row) => z.string().parse(row.id));
  }

  saveWorld(id: string, value: Record<string, z.infer<ReturnType<typeof z.json>>>) {
    const checked = z.record(z.string(), z.json()).parse(value);
    const serialized = JSON.stringify(checked);
    this.executor.run(
      query
        .insertInto('world_settings')
        .values({ id, value: serialized })
        .onConflict((conflict) => conflict.column('id').doUpdateSet({ value: serialized })),
    );
  }

  resetWorld(id: string) {
    this.executor.run(query.deleteFrom('world_settings').where('id', '=', id));
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }
}

export const defaultRiderSettings = riderSettingsSchema.parse({});

export class RiderRepository {
  checkRider(storage: string, playerId: number) {
    const path = resolve(storage, 'zluggish.db');

    if (!existsSync(path)) throw new ConfigError('Unknown rider; initialize accounts before changing preferences');
    const db = new DatabaseSync(path, { readOnly: true });

    try {
      if (!new SqliteExecutor(db).get(query.selectFrom('user').select('player_id').where('player_id', '=', playerId)))
        throw new ConfigError('Unknown rider');
    } finally {
      db.close();
    }
  }
}
