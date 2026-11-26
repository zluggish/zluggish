import { t } from '#src/i18n/index';
import { ConfigError, decodeConfigInput, validateConfig } from '#src/config/index';
import { CONFIG_NAME } from '#src/config/load';
import type { ConfigInput } from '#src/config/schema';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { AssetFiles } from '#src/repositories/files.repository';
import { LockRepository } from '#src/repositories/lock.repository';
import type { Preference } from '#src/dtos/settings.dto';
import { SettingsStore } from '#src/repositories/settings.repository';
import { preferenceSchema } from '#src/dtos/settings.dto';
import { PositiveInt, strict, withDefault } from '#src/schema';
import { parse as parseIni } from 'ini';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupLegacyStorage } from '#src/migrations/storage';
import { Exit, Schema } from 'effect';

const journalSchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String.check(Schema.isUUID()),
  output: Schema.String,
  source: Schema.String,
  preferences: Schema.Array(preferenceSchema),
  backup: Schema.NullOr(Schema.String),
});

const decodeJournal = Schema.decodeUnknownSync(journalSchema, strict);

const decodeLegacyRider = Schema.decodeUnknownSync(
  Schema.Struct({
    player_id: PositiveInt,
    enable_ghosts: Schema.Literals([0, 1]),
  }),
);

const decodeDiscord = Schema.decodeUnknownExit(
  Schema.Struct({
    discord: Schema.Struct({
      channel: Schema.String.check(Schema.isPattern(/^\d+$/)),
      welcome_message: Schema.String.pipe(withDefault('')),
      help_message: Schema.String.pipe(withDefault('')),
      announce_players: Schema.Union([Schema.String, Schema.Boolean]).pipe(withDefault(false)),
    }),
  }),
);

export interface MigrationOptions {
  storage: string;
  output: string;
  dryRun?: boolean;
  soloPlayer?: number;
}

function camelCase(key: string) {
  return key.replaceAll(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

// Legacy bot documents are data, not executable configuration.
const decodeLegacyJson = Schema.decodeUnknownSync(Schema.Json);

type LegacyValue = typeof Schema.Json.Type;

const isLegacyArray = Schema.is(Schema.Array(Schema.Json));

const isLegacyObject = Schema.is(Schema.Record(Schema.String, Schema.Json));

function convertKeys(value: LegacyValue): LegacyValue {
  if (isLegacyArray(value)) {
    return value.map((element) => convertKeys(element));
  }

  if (!isLegacyObject(value)) {
    return value;
  }

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [camelCase(key), convertKeys(item)]));
}

const decodeLegacyObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));

const decodeLegacyPelotons = Schema.decodeUnknownSync(
  Schema.Struct({ pelotons: Schema.Array(Schema.Record(Schema.String, Schema.Json)) }),
);

function legacySection(file: string, ...input: Parameters<typeof decodeConfigInput>) {
  try {
    return decodeConfigInput(...input);
  } catch {
    throw new ConfigError(t('invalid_legacy_configuration', { value1: file }));
  }
}

export function renderConfig(config: ConfigInput) {
  validateConfig(config);

  const serialized = JSON.stringify(config, null, 2)
    .replaceAll('\u{2028}', String.raw`\u2028`)
    .replaceAll('\u{2029}', String.raw`\u2029`);

  return `import { defineConfig } from "zluggish/config";\n\nexport default defineConfig(${serialized});\n`;
}

export function migrationCandidate(options: MigrationOptions) {
  const storage = resolve(options.storage);
  const output = resolve(options.output);

  if (basename(output) !== CONFIG_NAME) {
    throw new ConfigError(t('migrate_output_name_required', { value1: CONFIG_NAME }));
  }

  if (existsSync(output)) {
    throw new ConfigError(t('migrate_destination_exists'));
  }

  if (!existsSync(storage)) {
    throw new ConfigError(t('migrate_storage_directory_missing'));
  }
  const exists = (name: string) => existsSync(resolve(storage, name));

  const text = (name: string) => readFileSync(resolve(storage, name), 'utf8').trimEnd();

  const reference = (name: string) => {
    const path = resolve(storage, name);
    const rel = relative(dirname(output), path);

    return rel || path;
  };

  const botCount = exists('enable_bots.txt') ? text('enable_bots.txt').split(/\r?\n/, 1)[0] : undefined;

  const multiplier = botCount && /^-?\d+$/.test(botCount.trim()) ? Math.min(Number(botCount), 100) : 1;

  const discordFile = exists('discord.cfg') ? reference('discord.cfg') : '';
  let discord = decodeConfigInput({}).integrations.discord;

  if (discordFile) {
    const parsed = decodeDiscord(parseIni(text('discord.cfg')));

    if (Exit.isFailure(parsed)) {
      throw new ConfigError(t('migrate_discord_config_invalid'));
    }
    const values = parsed.value.discord;
    const yes = ['1', 'yes', 'true', 'on'];
    const no = ['0', 'no', 'false', 'off'];

    if (![...yes, ...no].includes(String(values.announce_players).toLowerCase())) {
      throw new ConfigError(t('migrate_discord_announce_players_invalid'));
    }

    discord = {
      enabled: true,
      credentialsFile: discordFile,
      channel: values.channel,
      welcomeMessage: values.welcome_message,
      helpMessage: values.help_message,
      announcePlayers: yes.includes(String(values.announce_players).toLowerCase()),
    };
  }

  let { pelotons, soloBlob } = decodeConfigInput({});

  if (exists('peloton.txt')) {
    const value = decodeLegacyPelotons(JSON.parse(text('peloton.txt')));

    const entries = value.pelotons.map((entry, index) => {
      const converted = decodeLegacyObject(convertKeys(entry));

      return { ...converted, id: `legacy-${index + 1}` };
    });

    pelotons = legacySection('peloton.txt', { pelotons: entries }).pelotons;
  }

  if (exists('solo_blob.txt')) {
    const value = decodeLegacyJson(JSON.parse(text('solo_blob.txt')));

    soloBlob = legacySection('solo_blob.txt', { soloBlob: convertKeys(value) }).soloBlob;
  }

  const config = validateConfig({
    storageDir: reference('.'),
    server: {
      advertisedIp: exists('server-ip.txt') ? text('server-ip.txt') : '127.0.0.1',
    },
    dns: { enabled: exists('fake-dns.txt') },
    leaderboards: { allTime: exists('all_time_leaderboards.txt') },
    equipment: {
      unlockEntitlements: exists('unlock_entitlements.txt'),
      unlockAll: exists('unlock_all_equipment.txt'),
      unlockBikeUpgrades: exists('unlock_bike_upgrades.txt'),
    },
    proxy: {
      mode: exists('cdn-proxy.txt') ? 'enabled' : exists('disable_proxy.txt') ? 'disabled' : 'auto',
    },
    bots: {
      enabled: exists('enable_bots.txt'),
      multiplier,
      ridersFile: exists('bot.txt') ? reference('bot.txt') : '',
    },
    ghosts: {
      profileFile: exists('ghost_profile.txt') ? reference('ghost_profile.txt') : '',
    },
    integrations: {
      garmin: {
        domain: exists('garmin_domain.txt') ? text('garmin_domain.txt').split(/\r?\n/, 1)[0] : 'garmin.com',
      },
      discord,
    },
    pelotons,
    soloBlob,
  });

  const riders = [];
  const currentDatabase = resolve(storage, 'zluggish.db');
  const database = existsSync(currentDatabase) ? currentDatabase : resolve(storage, 'zwift-offline.db');

  if (existsSync(database)) {
    const db = new DatabaseSync(database, { readOnly: true });

    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user'").get()) {
        const hasGhosts = db
          .prepare('PRAGMA table_info(user)')
          .all()
          .some((row) => row.name === 'enable_ghosts');

        const rows = db
          .prepare(
            hasGhosts
              ? 'SELECT player_id, enable_ghosts FROM user ORDER BY player_id'
              : 'SELECT player_id, 1 AS enable_ghosts FROM user ORDER BY player_id',
          )
          .all();

        for (const row of rows) {
          riders.push(decodeLegacyRider(row));
        }
      }
    } finally {
      db.close();
    }
  }

  if (riders.length === 0) {
    const folders = readdirSync(storage).filter(
      (name) => /^\d+$/.test(name) && existsSync(resolve(storage, name, 'profile.bin')),
    );

    if (folders.length > 0 && !options.soloPlayer) {
      throw new ConfigError(t('migrate_solo_player_required'));
    }

    if (options.soloPlayer) {
      if (!folders.includes(String(options.soloPlayer))) {
        throw new ConfigError(t('migrate_solo_profile_missing'));
      }

      riders.push({
        player_id: options.soloPlayer,
        enable_ghosts: exists('enable_ghosts.txt') ? 1 : 0,
      });
    }
  } else if (options.soloPlayer) {
    throw new ConfigError(t('migrate_solo_player_inapplicable'));
  }

  const preferences: Array<Preference> = riders.map((rider) => {
    const folder = String(rider.player_id);
    const method = `${folder}/strava_upload_method.txt`;
    const bridge = `${folder}/trainingpeaks_bridge_folder.txt`;

    const parsed = Schema.decodeUnknownExit(
      preferenceSchema,
      strict,
    )({
      playerId: rider.player_id,
      overrides: {
        'ghosts.enabled': rider.enable_ghosts === 1,
        'uploads.zwift.enabled': exists(`${folder}/zwift_upload.txt`),
        'uploads.strava.method': exists(method) ? text(method).split(/\r?\n/, 1)[0] : 'paid',
        'devices.zwiftClick.enabled': exists(`${folder}/zwift_click.txt`),
        'workouts.trainingpeaks.bridgeFolder': exists(bridge) ? resolve(storage, text(bridge)) : '',
      },
    });

    if (Exit.isFailure(parsed)) {
      throw new ConfigError(t('migrate_preferences_invalid', { value1: rider.player_id }));
    }

    return parsed.value;
  });

  const store = SettingsStore.openReadOnly(storage);

  if (store) {
    try {
      for (const preference of preferences) {
        const exists = store.has(preference.playerId);

        if (exists && JSON.stringify(store.read(preference.playerId)) !== JSON.stringify(preference.overrides)) {
          throw new ConfigError(t('migrate_preferences_conflict', { value1: preference.playerId }));
        }
      }
    } finally {
      store.close();
    }
  }

  // Deliberately ignore *.jsonc: only original pre-JSONC inputs are supported.
  return { config, preferences, output, source: renderConfig(config) };
}

/** Checkpoints are durable evidence, not a separate mutable status:
no journal -> journal prepared -> settings migration ID committed -> output linked -> journal removed.
Resume repeats idempotent effects; changed output refuses continuation. Startup blocks on the journal.
*/
export async function migrateConfig(options: MigrationOptions) {
  if (options.dryRun) {
    const candidate = migrationCandidate(options);

    return {
      output: candidate.output,
      riders: candidate.preferences.map((p) => p.playerId),
      dryRun: true,
    };
  }

  const release = await new LockRepository().acquireStorageLock(options.storage);
  const journalPath = resolve(options.storage, '.config-migration.json');

  try {
    let journal;

    if (existsSync(journalPath)) {
      journal = decodeJournal(JSON.parse(readFileSync(journalPath, 'utf8')));

      if (resolve(options.output) !== journal.output) {
        throw new ConfigError(t('migrate_destination_conflict'));
      }
    } else {
      const candidate = migrationCandidate(options);
      const id = new CryptoRepository().randomUUID();
      const backupPath = backupLegacyStorage(options.storage, 'config-migration');

      journal = decodeJournal({
        version: 1,
        id,
        output: candidate.output,
        source: candidate.source,
        preferences: candidate.preferences,
        backup: backupPath,
      });
      new AssetFiles().writeDurable(journalPath, JSON.stringify(journal));
    }

    if (existsSync(journal.output) && readFileSync(journal.output, 'utf8') !== journal.source) {
      throw new ConfigError(t('migrate_output_changed'));
    }

    const settings = SettingsStore.open(options.storage);

    try {
      settings.import(journal.id, journal.preferences);
    } finally {
      settings.close();
    }

    if (!existsSync(journal.output)) {
      new AssetFiles().writeDurable(journal.output, journal.source);
    }

    unlinkSync(journalPath);

    return {
      output: journal.output,
      riders: journal.preferences.map((p) => p.playerId),
      dryRun: false,
    };
  } finally {
    await release();
  }
}
