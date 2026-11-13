import { log } from '#src/logging';
import { createServices } from '#src/composition';
import type { ResolvedConfig } from '#src/config/index';
import { packageRoot } from '#src/config/load';
import type { RepositoryContext } from '#src/context';
import type { Runtime } from '#src/http/runtime';
import { Accounts } from '#src/repositories/accounts.repository';
import { Sessions } from '#src/repositories/browser-session.repository';
import { acquireStorageLock } from '#src/repositories/lock.repository';
import { ProfileImports } from '#src/repositories/profile-import.repository';
import { Profiles } from '#src/repositories/profile.repository';
import { SettingsStore } from '#src/repositories/settings.repository';
import { Simulation } from '#src/world/simulation';
import { World } from '#src/world/state';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import { startDiscord } from '#src/repositories/discord.repository';

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
      .parse(JSON.parse(readFileSync(resolve(packageRoot(), '../assets/tokens.json'), 'utf8')));

    const context: RepositoryContext = {
      config,
      assets,
      accounts,
      sessions,
      profiles,
      settings,
      world,
      tokens,
    };

    const runtime: Runtime = Object.assign(context, { services: createServices(context) });

    new ProfileImports(accounts, world).recover();
    const simulation = new Simulation(runtime);
    runtime.services.activities.recover();
    simulation.start();
    runtime.services.uploads.start();

    if (config.integrations.discord.enabled) {
      try {
        runtime.discord = startDiscord(runtime);
        world.presence = (id, joining) => runtime.discord?.online(id, joining);
      } catch {
        log.warn('Discord configuration failed; local riding remains available');
      }
    }

    return {
      runtime,
      close: async () => {
        simulation.close();
        await runtime.services.uploads.close();
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
