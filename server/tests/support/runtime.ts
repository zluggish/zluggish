import { createServices } from '#src/composition';
import { validateConfig } from '#src/config/index';
import { packageRoot } from '#src/config/load';
import { createApp } from '#src/http/app';
import { AccountsService } from '#src/services/auth.service';
import { SessionsService } from '#src/services/browser-session.service';
import { Profiles } from '#src/repositories/profile.repository';
import { SettingsStore } from '#src/repositories/settings.repository';
import { World } from '#src/world/state';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { z } from 'zod';

export function runtimeFixture(t: TestContext) {
  const storage = mkdtempSync(resolve(tmpdir(), 'zluggish-accounts-'));
  const accounts = new AccountsService(storage);
  const sessions = new SessionsService(accounts);
  const profiles = new Profiles(accounts.storage, accounts.repository);
  const settings = new SettingsStore(storage);
  const world = new World();
  const config = validateConfig({ storageDir: storage });
  const assets = resolve(packageRoot(), '../assets');

  const tokens = z
    .object({ access: z.string(), refresh: z.string(), id: z.string() })
    .parse(JSON.parse(readFileSync(resolve(packageRoot(), '../assets/tokens.json'), 'utf8')));

  const context = {
    accounts,
    sessions,
    profiles,
    settings,
    world,
    config,
    assets,
    tokens,
  };

  const runtime = Object.assign(context, { services: createServices(context) });

  const app = createApp({ gameInfo: '{}', gameInfoHash: '0', variants: '{}' }, runtime);

  t.after(() => {
    accounts.close();
    settings.close();
    rmSync(storage, { recursive: true, force: true });
  });

  return { ...runtime, app };
}
