import { Resources } from '#src/node/lifecycle/resources';
import { createServices } from '#src/composition';
import type { ResolvedConfig } from '#src/config/index';
import { packageRoot } from '#src/config/load';
import type { RepositoryContext } from '#src/context';
import type { Runtime } from '#src/http/runtime';
import { LockRepository } from '#src/repositories/lock.repository';
import { AccountsService } from '#src/services/auth.service';
import { SessionsService } from '#src/services/browser-session.service';
import { ImportsService } from '#src/services/profile-import.service';
import { Simulation } from '#src/world/simulation';
import { World } from '#src/world/state';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import { DiscordService } from '#src/services/discord.service';

export async function openRuntime(config: ResolvedConfig, assets: string) {
  const resources = new Resources();
  const release = await new LockRepository().acquireStorageLock(config.storageDir);
  resources.defer(release);

  try {
    const accounts = new AccountsService(config.storageDir);
    resources.defer(() => accounts.close());
    const settings = accounts.repositories.settingsRepository;
    resources.defer(() => settings.close());
    const sessions = new SessionsService(accounts);
    const profiles = accounts.repositories.profileRepository;
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
    resources.defer(() => runtime.discord?.close());
    resources.defer(() => runtime.services.uploads.close());
    resources.defer(() => simulation.close());
    resources.defer(() => world.lifecycle.close());
    runtime.services.activities.recover();
    simulation.start();
    runtime.services.uploads.start();

    if (config.integrations.discord.enabled) {
      try {
        runtime.discord = new DiscordService(runtime.accounts.repositories).startDiscord(runtime);
        world.presence = (id, joining) => runtime.discord?.online(id, joining);
      } catch {
        world.lifecycle.log.warn(
          'discord.configuration_failed',
          'Discord configuration failed; local riding remains available',
        );
      }
    }

    return { runtime, close: () => resources.close() };
  } catch (error) {
    try {
      await resources.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Runtime initialization and cleanup failed', {
        cause: cleanupError,
      });
    }

    throw error;
  }
}
