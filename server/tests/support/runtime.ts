import { makeAppRuntime } from '#src/layers';
import { validateConfig } from '#src/config/index';
import type { ConfigInput } from '#src/config/index';
import { packageRoot } from '#src/config/load';
import { createGameApp } from '#src/http/app';
import { AccountsService } from '#src/services/auth.service';
import { SessionsService } from '#src/services/browser-session.service';
import { World } from '#src/world/state';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { Schema } from 'effect';

type ApiInput = NonNullable<NonNullable<ConfigInput['network']>['api']>;

export function runtimeFixture(t: TestContext, publicUrl: string | null = null, webEnabled = true, api: ApiInput = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'zluggish-accounts-'));
  const storage = resolve(root, 'storage');
  const accounts = AccountsService.open(storage);
  const sessions = SessionsService.open(accounts);
  const profiles = accounts.repositories.profileRepository;
  const settings = accounts.repositories.settingsRepository;
  const world = new World();
  const config = validateConfig({ storageDir: storage, network: { web: { publicUrl, enabled: webEnabled }, api } });
  const assets = resolve(packageRoot(), '../assets');

  const tokens = Schema.decodeUnknownSync(
    Schema.Struct({ access: Schema.String, refresh: Schema.String, id: Schema.String }),
  )(JSON.parse(readFileSync(resolve(packageRoot(), '../assets/tokens.json'), 'utf8')));

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

  const effects = makeAppRuntime(context);
  const runtime = Object.assign(context, { effects });

  const app = createGameApp({ gameInfo: '{}', gameInfoHash: '0', variants: '{}' }, runtime);

  t.after(async () => {
    await effects.dispose();
    accounts.close();
    settings.close();
    rmSync(root, { recursive: true, force: true });
  });

  return { ...runtime, app };
}
