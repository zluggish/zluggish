import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ConfigError, validateRiderSettings } from '#src/config/index';
import type { RiderSettings } from '#src/config/index';
import { riderSettingsSchema } from '#src/config/schema';

export const overrideSchema = z.strictObject({
  'ghosts.enabled': z.boolean().optional(),
  'uploads.zwift.enabled': z.boolean().optional(),
  'uploads.strava.method': z.enum(['paid', 'free']).optional(),
  'devices.zwiftClick.enabled': z.boolean().optional(),
  'workouts.trainingpeaks.bridgeFolder': z.string().optional(),
});

export type Overrides = z.infer<typeof overrideSchema>;

export type SettingKey = keyof Overrides;

export const settingKeySchema = overrideSchema.keyof();

export const preferenceSchema = z.object({
  playerId: z.number().int().positive().safe(),
  overrides: overrideSchema,
});

export type Preference = z.infer<typeof preferenceSchema>;

export function resolveRiderSettings(defaults: RiderSettings, overrides: Overrides) {
  return validateRiderSettings({
    ghosts: { enabled: overrides['ghosts.enabled'] ?? defaults.ghosts.enabled },
    uploads: {
      zwift: {
        enabled: overrides['uploads.zwift.enabled'] ?? defaults.uploads.zwift.enabled,
      },
      strava: {
        method: overrides['uploads.strava.method'] ?? defaults.uploads.strava.method,
      },
    },
    devices: {
      zwiftClick: {
        enabled: overrides['devices.zwiftClick.enabled'] ?? defaults.devices.zwiftClick.enabled,
      },
    },
    workouts: {
      trainingpeaks: {
        bridgeFolder: overrides['workouts.trainingpeaks.bridgeFolder'] ?? defaults.workouts.trainingpeaks.bridgeFolder,
      },
    },
  });
}

const rowSchema = z.object({ value: z.string() });

export class SettingsStore {
  readonly db: DatabaseSync;

  constructor(storage: string, readOnly = false) {
    const path = resolve(storage, 'settings.db');

    if (readOnly && !existsSync(path)) throw new ConfigError('No persisted preferences; initialize storage first');

    if (!readOnly) mkdirSync(storage, { recursive: true });

    this.db = new DatabaseSync(path, { readOnly, timeout: 5000 });

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

  read(playerId: number): Overrides {
    const row = this.db.prepare('SELECT value FROM rider_settings WHERE player_id=?').get(playerId);

    if (!row) return {};

    return overrideSchema.parse(JSON.parse(rowSchema.parse(row).value));
  }

  save(playerId: number, overrides: Overrides) {
    const candidate = preferenceSchema.parse({ playerId, overrides });
    this.db
      .prepare('INSERT INTO rider_settings VALUES (?, ?) ON CONFLICT(player_id) DO UPDATE SET value=excluded.value')
      .run(candidate.playerId, JSON.stringify(candidate.overrides));
  }

  import(id: string, preferences: Preference[]) {
    this.db.exec('BEGIN IMMEDIATE');

    try {
      if (!this.db.prepare('SELECT 1 FROM config_migration WHERE id=?').get(id)) {
        for (const preference of preferences) {
          const row = this.db.prepare('SELECT value FROM rider_settings WHERE player_id=?').get(preference.playerId);

          if (row && JSON.stringify(this.read(preference.playerId)) !== JSON.stringify(preference.overrides))
            throw new ConfigError(`Conflicting persisted preferences for rider ${preference.playerId}`);

          this.save(preference.playerId, preference.overrides);
        }

        this.db.prepare('INSERT INTO config_migration VALUES (?)').run(id);
      }

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  world(id: string) {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='world_settings'").get()) return {};

    const row = this.db.prepare('SELECT value FROM world_settings WHERE id=?').get(id);

    return row ? z.record(z.string(), z.json()).parse(JSON.parse(rowSchema.parse(row).value)) : {};
  }

  worldIds() {
    return this.db
      .prepare('SELECT id FROM world_settings ORDER BY id')
      .all()
      .map((row) => z.string().parse(row.id));
  }

  saveWorld(id: string, value: Record<string, z.infer<ReturnType<typeof z.json>>>) {
    const checked = z.record(z.string(), z.json()).parse(value);
    this.db
      .prepare('INSERT INTO world_settings VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .run(id, JSON.stringify(checked));
  }

  resetWorld(id: string) {
    this.db.prepare('DELETE FROM world_settings WHERE id=?').run(id);
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }
}

export function checkRider(storage: string, playerId: number) {
  const currentDatabase = resolve(storage, 'zluggish.db');
  const path = existsSync(currentDatabase) ? currentDatabase : resolve(storage, 'zwift-offline.db');

  if (!existsSync(path)) throw new ConfigError('Unknown rider; initialize accounts before changing preferences');
  const db = new DatabaseSync(path, { readOnly: true });

  try {
    if (!db.prepare('SELECT player_id FROM user WHERE player_id=?').get(playerId))
      throw new ConfigError('Unknown rider');
  } finally {
    db.close();
  }
}

export const defaultRiderSettings = riderSettingsSchema.parse({});
