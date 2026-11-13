import { ConfigError } from '#src/config/index';
import type { LoadOptions } from '#src/config/load';
import { loadConfig, packageRoot, selectConfigPath } from '#src/config/load';
import { migrateConfig } from '#src/config/migrate';
import { migrateAccounts } from '#src/migrations/accounts';
import { AssetFiles } from '#src/repositories/files.repository';
import { LockRepository } from '#src/repositories/lock.repository';
import type { Overrides } from '#src/dtos/settings.dto';
import { RiderRepository, SettingsStore } from '#src/repositories/settings.repository';
import { overrideSchema, settingKeySchema } from '#src/dtos/settings.dto';
import { AccountsService } from '#src/services/auth.service';
import { SettingsService } from '#src/services/settings.service';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

export const HELP = `Usage: zluggish [--config PATH] [--storage-dir DIR] config init|validate|show|typecheck|migrate
       zluggish [--config PATH] settings show|set|reset --user ID [KEY] [VALUE]

accounts recover --user ID --password-file PATH  Change a rider password offline
accounts recover --user ID --remove-password     Remove a rider password offline
accounts migrate [--solo-player ID]          Convert the legacy account database offline
config migrate --dry-run                     Preview direct legacy -> zluggish.config.ts migration
config migrate --output PATH [--solo-player ID]  Migrate offline, preserving original files
config init                                 Create a default typed config; never overwrite
config validate                             Evaluate trusted config and validate its values
config typecheck                            Typecheck the selected operator config
settings set/reset                          Update SQLite overrides, never TypeScript source

Config files are trusted executable code. Editing operator config requires restart.
JSONC is not read or produced. The Node server is still under compatibility development.
`;

export async function run(argv: string[], output: (message: string) => void = console.log): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: 'string' },
      'storage-dir': { type: 'string' },
      output: { type: 'string' },
      'dry-run': { type: 'boolean' },
      user: { type: 'string' },
      'solo-player': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      admin: { type: 'boolean' },
      'remove-password': { type: 'boolean' },
      'password-file': { type: 'string' },
    },
  });

  const [group, action, key, raw, ...extra] = positionals;

  if (values.help || !group) {
    output(HELP);

    return 0;
  }

  if (extra.length > 0) throw new ConfigError('Unexpected arguments');
  const containerStorage = process.env.ZLUGGISH_CONTAINER_STORAGE_DIR;

  const containerConfig = containerStorage
    ? resolve(values['storage-dir'] ?? process.env.ZLUGGISH_STORAGE_DIR ?? containerStorage, 'zluggish.config.ts')
    : undefined;

  const selected = selectConfigPath(
    values.config ??
      (process.env.ZLUGGISH_CONFIG === undefined && containerConfig && existsSync(containerConfig)
        ? containerConfig
        : undefined),
  );

  let storage = resolve(
    values['storage-dir'] ??
      process.env.ZLUGGISH_STORAGE_DIR ??
      containerStorage ??
      resolve(packageRoot(), '../storage'),
  );

  if (group === 'accounts') {
    if (values['storage-dir'] === undefined && !process.env.ZLUGGISH_STORAGE_DIR && existsSync(selected)) {
      const loaded = await loadConfig({ path: selected });
      storage = loaded.config.storageDir;
    } else if ((values.config !== undefined || process.env.ZLUGGISH_CONFIG !== undefined) && !existsSync(selected)) {
      throw new ConfigError(`Missing ${selected}`);
    }

    const release = await new LockRepository().acquireStorageLock(storage);

    try {
      if (action === 'migrate') {
        const selected = values['solo-player'];
        await migrateAccounts(
          storage,
          selected === undefined ? undefined : z.coerce.number().int().positive().safe().parse(selected),
        );
        output('Accounts migrated');
      } else if (action === 'recover') {
        const playerId = z.coerce.number().int().positive().safe().parse(values.user);

        if (!!values['remove-password'] === !!values['password-file'])
          throw new ConfigError('Choose --remove-password or --password-file PATH');
        const accounts = new AccountsService(storage);

        try {
          if (!accounts.get(playerId)) throw new ConfigError('Unknown rider');
          const passwordFile = values['password-file'];

          const password = passwordFile ? readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, '') : null;

          if (password === '') throw new ConfigError('Password must not be empty');

          await accounts.changePassword(playerId, password, values.admin ?? false);
          output('Account recovered; previous tokens revoked');
        } finally {
          accounts.close();
        }
      } else throw new ConfigError('Unknown accounts command');
    } finally {
      await release();
    }

    return 0;
  }

  if (group === 'config') {
    if (key !== undefined || raw !== undefined) throw new ConfigError('Unexpected config arguments');

    switch (action) {
      case 'init': {
        new AssetFiles().writeDurable(
          selected,
          readFileSync(resolve(packageRoot(), '../examples/zluggish.config.ts'), 'utf8'),
        );
        output(`Created ${selected}`);

        return 0;
      }

      case 'migrate': {
        const options = {
          storage,
          output: resolve(values.output ?? selected),
          dryRun: values['dry-run'] ?? false,
        };

        const solo = values['solo-player'];

        const result =
          solo === undefined
            ? await migrateConfig(options)
            : await migrateConfig({
                ...options,
                soloPlayer: z.coerce.number().int().positive().safe().parse(solo),
              });

        output(JSON.stringify(result, null, 2));

        return 0;
      }

      case 'typecheck': {
        // The runtime image includes TypeScript for offline operator config checks.
        const ts = await import('typescript');

        const program = ts.createProgram([selected], {
          noEmit: true,
          strict: true,
          skipLibCheck: true,
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          paths: {
            'zluggish/config': [
              resolve(
                packageRoot(),
                import.meta.url.endsWith('.ts') ? 'src/config/index.ts' : 'dist/src/config/index.d.ts',
              ),
            ],
          },
          typeRoots: [resolve(packageRoot(), 'node_modules/@types')],
          types: ['node'],
        });

        const diagnostics = ts.getPreEmitDiagnostics(program);

        for (const diagnostic of diagnostics) {
          // Do not print source snippets or operator-provided values in diagnostics.
          output(`${diagnostic.file?.fileName ?? selected}: TypeScript ${diagnostic.code}`);
        }

        return diagnostics.length > 0 ? 2 : 0;
      }

      case 'validate':
      case 'show': {
        const options: LoadOptions = { path: selected };

        if (values['storage-dir'] !== undefined) options.storageDir = storage;
        const loaded = await loadConfig(options);

        if (action === 'validate') output(`Valid: ${loaded.path}`);
        else
          output(
            JSON.stringify(
              {
                path: loaded.path,
                storageDir: loaded.config.storageDir,
                network: loaded.config.network,
                accounts: loaded.config.accounts,
                bots: {
                  enabled: loaded.config.bots.enabled,
                  multiplier: loaded.config.bots.multiplier,
                },
                omitted:
                  'Paths, integration values, rider defaults and operator strings are omitted to avoid exposing secrets',
              },
              null,
              2,
            ),
          );

        return 0;
      }

      default: {
        throw new ConfigError('Unknown config command');
      }
    }
  }

  if (group !== 'settings' || !['show', 'set', 'reset'].includes(action ?? ''))
    throw new ConfigError('Unknown command');
  const playerId = z.coerce.number().int().positive().safe().parse(values.user);
  const options: LoadOptions = { path: selected };

  if (values['storage-dir'] !== undefined) options.storageDir = storage;
  const { config } = await loadConfig(options);
  new RiderRepository().checkRider(config.storageDir, playerId);

  if (action === 'show') {
    if (key !== undefined) throw new ConfigError('Unexpected settings show arguments');
    const path = resolve(config.storageDir, 'settings.db');

    const store = existsSync(path) ? new SettingsStore(config.storageDir, true) : null;

    try {
      output(
        JSON.stringify(
          SettingsService.resolveRiderSettings(config.riderDefaults, store?.read(playerId) ?? {}),
          null,
          2,
        ),
      );
    } finally {
      store?.close();
    }

    return 0;
  }

  const setting = settingKeySchema.parse(key);

  if (action === 'set' && raw === undefined) throw new ConfigError('Provide a JSON setting value');

  if (action === 'reset' && raw !== undefined) throw new ConfigError('Unexpected reset value');
  const value = action === 'set' ? JSON.parse(raw ?? '') : null;

  const change = (overrides: Overrides) => {
    const candidate = overrideSchema.parse(action === 'set' ? { ...overrides, [setting]: value } : overrides);

    if (action === 'reset') delete candidate[setting];

    return candidate;
  };

  if (values['dry-run']) {
    const store = existsSync(resolve(config.storageDir, 'settings.db'))
      ? new SettingsStore(config.storageDir, true)
      : null;

    try {
      change(store?.read(playerId) ?? {});
    } finally {
      store?.close();
    }

    output('Valid change (dry run)');

    return 0;
  }

  const release = await new LockRepository().acquireStorageLock(config.storageDir);

  try {
    const store = new SettingsStore(config.storageDir);

    try {
      store.save(playerId, change(store.read(playerId)));
    } finally {
      store.close();
    }

    output('Settings saved');
  } finally {
    await release();
  }

  return 0;
}
