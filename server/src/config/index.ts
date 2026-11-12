import { z } from 'zod';
import { configSchema, riderSettingsSchema } from '#src/config/schema';

export type { ConfigInput, ResolvedConfig, RiderSettings } from '#src/config/schema';

import type { ConfigInput, ResolvedConfig } from '#src/config/schema';

export interface ConfigContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly configDir: string;
}

export type ConfigDefinition = ConfigInput | ((context: ConfigContext) => ConfigInput);

export function defineConfig<T extends ConfigDefinition>(config: T): T {
  return config;
}

export class ConfigError extends Error {}

export function validateConfig(value: ConfigInput): ResolvedConfig {
  const result = configSchema.safeParse(value);

  if (!result.success) throw validationError(result.error);
  const ids = result.data.pelotons.map((p) => p.id);

  if (new Set(ids).size !== ids.length) throw new ConfigError('pelotons: duplicate group ID');

  if (result.data.integrations.discord.enabled && !result.data.integrations.discord.credentialsFile)
    throw new ConfigError('integrations.discord.credentialsFile: required when enabled');

  return result.data;
}

export function validationError(error: z.ZodError): ConfigError {
  return new ConfigError(error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.code}`).join('; '));
}

export function validateRiderSettings(value: z.input<typeof riderSettingsSchema>) {
  const result = riderSettingsSchema.safeParse(value);

  if (!result.success) throw validationError(result.error);

  return result.data;
}

export function envBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;

  if (value !== 'true' && value !== 'false') throw new ConfigError('Expected true or false environment value');

  return value === 'true';
}

export function envInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;

  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new ConfigError('Expected integer environment value');

  return Number(value);
}
