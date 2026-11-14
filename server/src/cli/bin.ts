#!/usr/bin/env node
import { run } from '#src/cli/cli';
import { ConfigError } from '#src/config/index';

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  console.error(
    error instanceof ConfigError ? error.message : 'Command failed; check inputs, permissions and configuration',
  );
  process.exitCode = 2;
}
