import type { TestContext } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { Accounts } from '#src/domain/accounts/repository';
import { Sessions } from '#src/domain/accounts/sessions';
import { Profiles } from '#src/domain/profiles/store';
import { SettingsStore } from '#src/node/persistence/settings';
import { validateConfig } from '#src/config/index';
import { World } from '#src/world/state';
import { createApp } from '#src/http/app';
import { packageRoot } from '#src/config/load';

export function runtimeFixture(t: TestContext) {
  const storage = mkdtempSync(resolve(tmpdir(), 'zluggish-accounts-'));
  const accounts = new Accounts(storage);
  const sessions = new Sessions(accounts);
  const profiles = new Profiles(accounts);
  const settings = new SettingsStore(storage);
  const world = new World();
  const config = validateConfig({ storageDir: storage });
  const assets = resolve(packageRoot(), 'assets');

  const tokens = z
    .object({ access: z.string(), refresh: z.string(), id: z.string() })
    .parse(JSON.parse(readFileSync(resolve(packageRoot(), 'assets/tokens.json'), 'utf8')));

  const runtime = {
    accounts,
    sessions,
    profiles,
    settings,
    world,
    config,
    assets,
    tokens,
  };

  const app = createApp({ gameInfo: '{}', gameInfoHash: '0', variants: '{}' }, runtime);

  t.after(() => {
    accounts.close();
    settings.close();
    rmSync(storage, { recursive: true, force: true });
  });

  return { ...runtime, app };
}
