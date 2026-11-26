#!/usr/bin/env node
import { t } from '#src/i18n/index';
import { run } from '#src/cli/cli';
import { ConfigError } from '#src/config/index';

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : t('command_failed'));
  process.exitCode = 2;
}
