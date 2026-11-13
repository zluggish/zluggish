import { createServices } from '#src/composition';
import type { ResolvedConfig } from '#src/config/index';
import { packageRoot } from '#src/config/load';
import type { RepositoryContext } from '#src/context';
import type { Runtime } from '#src/http/runtime';
import { AccountsService } from '#src/services/auth.service';
import { SessionsService } from '#src/services/browser-session.service';
import { acquireStorageLock } from '#src/repositories/lock.repository';
import { ImportsService } from '#src/services/profile-import.service';
import { Profiles } from '#src/repositories/profile.repository';
import { SettingsStore } from '#src/repositories/settings.repository';
import { Simulation } from '#src/world/simulation';
import { World } from '#src/world/state';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import { startDiscord } from '#src/services/discord.service';

export async function openRuntime(config: ResolvedConfig, assets: string) {
  const release = await acquireStorageLock(config.storageDir);
  let accounts: AccountsService | null = null;
  let settings: SettingsStore | null = null;

  try {
    accounts = new AccountsService(config.storageDir);
    settings = new SettingsStore(config.storageDir);
    const sessions = new SessionsService(accounts);
    const profiles = new Profiles(accounts.storage, accounts.repository);
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

    new ImportsService(accounts, world).recover();
    const simulation = new Simulation(runtime);
    runtime.services.activities.recover();
    simulation.start();
    runtime.services.uploads.start();

    if (config.integrations.discord.enabled) {
      try {
        runtime.discord = startDiscord(runtime);
        world.presence = (id, joining) => runtime.discord?.online(id, joining);
      } catch {
        world.lifecycle.log.warn(
          'discord.configuration_failed',
          'Discord configuration failed; local riding remains available',
        );
      }
    }

    return {
      runtime,
      close: async () => {
        world.lifecycle.close();
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
