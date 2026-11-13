import { ConfigError, validateConfig } from '#src/config/index';
import { CONFIG_NAME } from '#src/config/load';
import { configSchema } from '#src/config/schema';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { AssetFiles } from '#src/repositories/files.repository';
import { LockRepository } from '#src/repositories/lock.repository';
import type { Preference } from '#src/dtos/settings.dto';
import { SettingsStore } from '#src/repositories/settings.repository';
import { preferenceSchema } from '#src/dtos/settings.dto';
import { parse as parseIni } from 'ini';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { z } from 'zod';

const journalSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().uuid(),
  output: z.string(),
  source: z.string(),
  preferences: z.array(preferenceSchema),
  backup: z.string().nullable(),
});

const legacyRiderSchema = z.object({
  player_id: z.number().int().positive().safe(),
  enable_ghosts: z.union([z.literal(0), z.literal(1)]),
});

const discordSchema = z.object({
  discord: z
    .object({
      channel: z.string().regex(/^\d+$/),
      welcome_message: z.string().default(''),
      help_message: z.string().default(''),
      announce_players: z.union([z.string(), z.boolean()]).default(false),
    })
    .passthrough(),
});

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
const legacyJson = z.json();

type LegacyValue = z.infer<typeof legacyJson>;

function convertKeys(value: LegacyValue): LegacyValue {
  const array = z.array(legacyJson).safeParse(value);

  if (array.success) return array.data.map((element) => convertKeys(element));
  const object = z.record(z.string(), legacyJson).safeParse(value);

  if (!object.success) return value;

  return Object.fromEntries(Object.entries(object.data).map(([key, item]) => [camelCase(key), convertKeys(item)]));
}

export function renderConfig(config: z.input<typeof configSchema>) {
  validateConfig(config);

  const serialized = JSON.stringify(config, null, 2)
    .replaceAll('\u{2028}', '\\u2028')
    .replaceAll('\u{2029}', '\\u2029');

  return `import { defineConfig } from "zluggish/config";\n\nexport default defineConfig(${serialized});\n`;
}

export function migrationCandidate(options: MigrationOptions) {
  const storage = resolve(options.storage);
  const output = resolve(options.output);

  if (basename(output) !== CONFIG_NAME) throw new ConfigError(`Migration output must be named ${CONFIG_NAME}`);

  if (existsSync(output)) throw new ConfigError('Destination exists; migration never overwrites configuration');

  if (!existsSync(storage)) throw new ConfigError('Legacy storage directory does not exist');
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
  let discord = configSchema.parse({}).integrations.discord;

  if (discordFile) {
    const parsed = discordSchema.safeParse(parseIni(text('discord.cfg')));

    if (!parsed.success) throw new ConfigError('discord.cfg: invalid legacy configuration');
    const values = parsed.data.discord;
    const yes = ['1', 'yes', 'true', 'on'];
    const no = ['0', 'no', 'false', 'off'];

    if (![...yes, ...no].includes(String(values.announce_players).toLowerCase()))
      throw new ConfigError('discord.cfg: invalid announce_players');

    discord = {
      enabled: true,
      credentialsFile: discordFile,
      channel: values.channel,
      welcomeMessage: values.welcome_message,
      helpMessage: values.help_message,
      announcePlayers: yes.includes(String(values.announce_players).toLowerCase()),
    };
  }

  let pelotons = configSchema.parse({}).pelotons;
  let soloBlob = configSchema.parse({}).soloBlob;

  if (exists('peloton.txt')) {
    const value = z
      .object({ pelotons: z.array(z.record(z.string(), legacyJson)) })
      .parse(JSON.parse(text('peloton.txt')));

    const entries = value.pelotons.map((entry, index) => {
      const converted = z.record(z.string(), legacyJson).parse(convertKeys(entry));

      return { ...converted, id: `legacy-${index + 1}` };
    });

    const parsed = configSchema.safeParse({ pelotons: entries });

    if (!parsed.success) throw new ConfigError('peloton.txt: invalid legacy configuration');

    pelotons = parsed.data.pelotons;
  }

  if (exists('solo_blob.txt')) {
    const value = legacyJson.parse(JSON.parse(text('solo_blob.txt')));
    const parsed = configSchema.safeParse({ soloBlob: convertKeys(value) });

    if (!parsed.success) throw new ConfigError('solo_blob.txt: invalid legacy configuration');

    soloBlob = parsed.data.soloBlob;
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

        for (const row of rows) riders.push(legacyRiderSchema.parse(row));
      }
    } finally {
      db.close();
    }
  }

  if (riders.length === 0) {
    const folders = readdirSync(storage).filter(
      (name) => /^\d+$/.test(name) && existsSync(resolve(storage, name, 'profile.bin')),
    );

    if (folders.length > 0 && !options.soloPlayer)
      throw new ConfigError(
        'Legacy solo data needs explicit --solo-player ID; no account is created by config migration',
      );

    if (options.soloPlayer) {
      if (!folders.includes(String(options.soloPlayer)))
        throw new ConfigError('--solo-player must identify an existing profile folder');

      riders.push({
        player_id: options.soloPlayer,
        enable_ghosts: exists('enable_ghosts.txt') ? 1 : 0,
      });
    }
  } else if (options.soloPlayer) throw new ConfigError('--solo-player only applies to legacy solo storage');

  const preferences: Preference[] = riders.map((rider) => {
    const folder = String(rider.player_id);
    const method = `${folder}/strava_upload_method.txt`;
    const bridge = `${folder}/trainingpeaks_bridge_folder.txt`;

    const parsed = preferenceSchema.safeParse({
      playerId: rider.player_id,
      overrides: {
        'ghosts.enabled': rider.enable_ghosts === 1,
        'uploads.zwift.enabled': exists(`${folder}/zwift_upload.txt`),
        'uploads.strava.method': exists(method) ? text(method).split(/\r?\n/, 1)[0] : 'paid',
        'devices.zwiftClick.enabled': exists(`${folder}/zwift_click.txt`),
        'workouts.trainingpeaks.bridgeFolder': exists(bridge) ? resolve(storage, text(bridge)) : '',
      },
    });

    if (!parsed.success) throw new ConfigError(`Invalid legacy preferences for rider ${rider.player_id}`);

    return parsed.data;
  });

  if (existsSync(resolve(storage, 'settings.db'))) {
    const store = new SettingsStore(storage, true);

    try {
      for (const preference of preferences) {
        const exists = store.has(preference.playerId);

        if (exists && JSON.stringify(store.read(preference.playerId)) !== JSON.stringify(preference.overrides))
          throw new ConfigError(`Conflicting persisted preferences for rider ${preference.playerId}`);
      }
    } finally {
      store.close();
    }
  }

  // Deliberately ignore *.jsonc: only original pre-JSONC inputs are supported.
  return { config, preferences, output, source: renderConfig(config) };
}

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
      journal = journalSchema.parse(JSON.parse(readFileSync(journalPath, 'utf8')));

      if (resolve(options.output) !== journal.output)
        throw new ConfigError('An interrupted migration targets another output; resume that destination first');
    } else {
      const candidate = migrationCandidate(options);
      const id = new CryptoRepository().randomUUID();
      const settingsPath = resolve(options.storage, 'settings.db');
      let backupPath: string | null = null;

      if (existsSync(settingsPath)) {
        const db = new DatabaseSync(settingsPath, { readOnly: true });

        try {
          backupPath = `${settingsPath}.${id}.bak`;
          await backup(db, backupPath);
        } finally {
          db.close();
        }
      }

      journal = journalSchema.parse({
        version: 1,
        id,
        output: candidate.output,
        source: candidate.source,
        preferences: candidate.preferences,
        backup: backupPath,
      });
      new AssetFiles().writeDurable(journalPath, JSON.stringify(journal));
    }

    if (existsSync(journal.output) && readFileSync(journal.output, 'utf8') !== journal.source)
      throw new ConfigError('Migration output changed; recover manually before continuing');

    const settings = new SettingsStore(options.storage);

    try {
      settings.import(journal.id, journal.preferences);
    } finally {
      settings.close();
    }

    if (!existsSync(journal.output)) new AssetFiles().writeDurable(journal.output, journal.source);

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
