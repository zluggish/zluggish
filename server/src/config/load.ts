import type { ResolvedConfig } from '#src/config/index';
import { ConfigError, validateConfig, validationError } from '#src/config/index';
import { configSchema } from '#src/config/schema';
import { createJiti } from 'jiti';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { createSecureContext } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

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

export function prepareContainerConfig(options: LoadOptions): LoadOptions {
  const env = options.env ?? process.env;
  const defaultStorage = env.ZLUGGISH_CONTAINER_STORAGE_DIR;

  if (!defaultStorage || options.path !== undefined || env.ZLUGGISH_CONFIG !== undefined) return options;
  const storage = resolve(options.storageDir ?? env.ZLUGGISH_STORAGE_DIR ?? defaultStorage);
  const path = resolve(storage, CONFIG_NAME);
  mkdirSync(storage, { recursive: true });

  try {
    copyFileSync(resolve(packageRoot(), '../examples/container/zluggish.config.ts'), path, constants.COPYFILE_EXCL);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }

  return { ...options, path };
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

    if (!parsed.success) throw validationError(parsed.error);

    config = validateConfig({
      ...parsed.data,
      storageDir: options.storageDir ?? env.ZLUGGISH_STORAGE_DIR ?? parsed.data.storageDir,
    });
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
    ['tls.certFile', resolved.tls.certFile],
    ['tls.keyFile', resolved.tls.keyFile],
  ]) {
    if (!resource) continue;

    try {
      if (!statSync(resource).isFile()) throw new ConfigError(`${field}: expected a readable regular file`);
      accessSync(resource, constants.R_OK);
    } catch (error) {
      if (error instanceof ConfigError) throw error;

      throw new ConfigError(`${field}: referenced file missing or unreadable`);
    }
  }

  if (existsSync(resolved.storageDir) && !statSync(resolved.storageDir).isDirectory())
    throw new ConfigError('storageDir: expected a directory');

  if (resolved.tls.certFile && resolved.tls.keyFile) {
    try {
      createSecureContext({
        cert: readFileSync(resolved.tls.certFile),
        key: readFileSync(resolved.tls.keyFile),
      });
    } catch {
      throw new ConfigError('tls: invalid certificate or private key');
    }
  }

  return { path, config: resolved };
}
