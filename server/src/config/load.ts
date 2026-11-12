import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { z } from 'zod';
import { configSchema } from '#src/config/schema';
import { ConfigError, validateConfig } from '#src/config/index';
import type { ResolvedConfig } from '#src/config/index';

export const CONFIG_NAME = 'zluggish.config.ts';

export function packageRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));

  while (dirname(current) !== current) {
    const manifest = resolve(current, 'package.json');

    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === 'zluggish') return current;
    current = dirname(current);
  }

  throw new ConfigError('Cannot locate server package');
}

export function selectConfigPath(path?: string, env = process.env): string {
  const selected = resolve(path ?? env.ZLUGGISH_CONFIG ?? resolve(packageRoot(), CONFIG_NAME));

  if (basename(selected) !== CONFIG_NAME) throw new ConfigError(`Configuration must be named ${CONFIG_NAME}`);

  return selected;
}

export interface LoadedConfig {
  path: string;
  config: ResolvedConfig;
}

export interface LoadOptions {
  path?: string;
  storageDir?: string;
  env?: NodeJS.ProcessEnv;
}

export async function loadConfig(options: LoadOptions = {}): Promise<LoadedConfig> {
  const env = options.env ?? process.env;
  const path = selectConfigPath(options.path, env);

  if (!existsSync(path)) throw new ConfigError(`Missing ${path}; run config init or config migrate`);
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';

  const jiti = createJiti(import.meta.url, {
    alias: {
      'zluggish/config': fileURLToPath(new URL(`index.${extension}`, import.meta.url)),
    },
    moduleCache: false,
    fsCache: false,
    tryNative: false,
  });

  let config: ResolvedConfig;

  try {
    const module = z.object({ default: z.unknown() }).parse(await jiti.import(path));

    const value = module.default;

    const factory = z
      .function({
        input: [
          z.object({
            env: z.record(z.string(), z.string().optional()),
            configDir: z.string(),
          }),
        ],
        output: z.unknown(),
      })
      .safeParse(value);

    const evaluated = factory.success ? factory.data({ env: { ...env }, configDir: dirname(path) }) : value;

    if (z.instanceof(Promise).safeParse(evaluated).success)
      throw new ConfigError('Async configuration is not supported');
    const parsed = configSchema.safeParse(evaluated);

    if (!parsed.success)
      throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.code}`).join('; '));

    config = validateConfig(parsed.data);
  } catch (error) {
    if (error instanceof ConfigError) throw error;

    // Loader exceptions can include source lines, environment values or secrets.
    throw new ConfigError(`Cannot evaluate ${path}; check module syntax and imports`);
  }

  const relative = (p: string) => (p && !isAbsolute(p) ? resolve(dirname(path), p) : p);

  const resolved = validateConfig({
    ...config,
    storageDir: resolve(options.storageDir ?? env.ZLUGGISH_STORAGE_DIR ?? relative(config.storageDir)),
    ghosts: {
      ...config.ghosts,
      profileFile: relative(config.ghosts.profileFile),
    },
    bots: { ...config.bots, ridersFile: relative(config.bots.ridersFile) },
    integrations: {
      ...config.integrations,
      discord: {
        ...config.integrations.discord,
        credentialsFile: relative(config.integrations.discord.credentialsFile),
      },
    },
    tls: {
      certFile: relative(config.tls.certFile),
      keyFile: relative(config.tls.keyFile),
    },
    riderDefaults: {
      ...config.riderDefaults,
      workouts: {
        trainingpeaks: {
          bridgeFolder: relative(config.riderDefaults.workouts.trainingpeaks.bridgeFolder),
        },
      },
    },
  });

  for (const [field, resource] of [
    ['ghosts.profileFile', resolved.ghosts.profileFile],
    ['bots.ridersFile', resolved.bots.ridersFile],
    ['integrations.discord.credentialsFile', resolved.integrations.discord.credentialsFile],
  ]) {
    if (resource && !existsSync(resource)) throw new ConfigError(`${field}: referenced file missing`);
  }

  return { path, config: resolved };
}
