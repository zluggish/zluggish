import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { ResolvedConfig } from '#src/config/index';
import { packageRoot } from '#src/config/load';
import { Accounts } from '#src/domain/accounts/repository';
import { Sessions } from '#src/domain/accounts/sessions';
import { Profiles } from '#src/domain/profiles/store';
import { ProfileImports } from '#src/domain/profiles/imports';
import { SettingsStore } from '#src/node/persistence/settings';
import { acquireStorageLock } from '#src/node/persistence/lock';
import { World } from '#src/world/state';
import { Simulation } from '#src/world/simulation';
import type { Runtime } from '#src/http/runtime';

import { startDiscord } from '#src/node/integrations/discord';

export async function openRuntime(config: ResolvedConfig, assets: string) {
  const release = await acquireStorageLock(config.storageDir);
  let accounts: Accounts | null = null;
  let settings: SettingsStore | null = null;

  try {
    accounts = new Accounts(config.storageDir);
    settings = new SettingsStore(config.storageDir);
    const sessions = new Sessions(accounts);
    const profiles = new Profiles(accounts);
    const world = new World();

    const tokens = z
      .object({ access: z.string(), refresh: z.string(), id: z.string() })
      .parse(JSON.parse(readFileSync(resolve(packageRoot(), 'assets/tokens.json'), 'utf8')));

    const runtime: Runtime = {
      config,
      assets,
      accounts,
      sessions,
      profiles,
      settings,
      world,
      tokens,
    };

    new ProfileImports(accounts, world).recover();
    const simulation = new Simulation(runtime);
    simulation.start();

    if (config.integrations.discord.enabled) {
      try {
        runtime.discord = startDiscord(runtime);
        world.presence = (id, joining) => runtime.discord?.online(id, joining);
      } catch {
        console.warn('Discord configuration failed; local riding remains available');
      }
    }

    return {
      runtime,
      close: async () => {
        simulation.close();
        await runtime.discord?.close();
        runtime.settings.close();
        runtime.accounts.close();
        await release();
      },
    };
  } catch (error) {
    settings?.close();
    accounts?.close();
    await release();
    throw error;
  }
}
