import { t } from '#src/i18n/index';
import { Effect, Schema, Scope } from 'effect';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ResolvedConfig } from '#src/config/index';
import { packageRoot } from '#src/config/load';
import type { RepositoryContext } from '#src/context';
import type { Runtime } from '#src/http/runtime';
import { makeAppRuntime } from '#src/layers';
import { Resources } from '#src/node/lifecycle/resources';
import { CheckpointRepository } from '#src/repositories/checkpoint.repository';
import { LockRepository } from '#src/repositories/lock.repository';
import { AccountsService } from '#src/services/auth.service';
import { SessionsService } from '#src/services/browser-session.service';
import type { Bridge } from '#src/services/chat-bridge.service';
import { DiscordService } from '#src/services/discord.service';
import { DurabilityService } from '#src/services/durability.service';
import { JobsService } from '#src/services/jobs.service';
import { MatrixService } from '#src/services/matrix.service';
import { MetricsService } from '#src/services/metrics.service';
import { ImportsService } from '#src/services/profile-import.service';
import { BackupService } from '#src/services/backup.service';
import { AppReleasesService } from '#src/services/app-releases.service';
import { TlsService } from '#src/services/tls.service';
import { RetentionService } from '#src/services/retention.service';
import { RideCompletionService } from '#src/services/ride-completion.service';
import { RideRecoveryService } from '#src/services/ride-recovery.service';
import { UploadsService } from '#src/services/uploads.service';
import { Simulation } from '#src/world/simulation';
import { World } from '#src/world/state';

const tokensSchema = Schema.Struct({ access: Schema.String, refresh: Schema.String, id: Schema.String });

const releasing = (dispose: () => void | Promise<void>): Effect.Effect<void, never, Scope.Scope> =>
  Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await dispose();
    }),
  );

/** A chat bridge that starts, or a warning when its configuration fails: local riding stays available. */
const optionalBridge = (world: World, name: string, start: Effect.Effect<Bridge>) =>
  start.pipe(
    Effect.map((bridge): Array<Bridge> => [bridge]),
    Effect.catchCause(() =>
      Effect.sync((): Array<Bridge> => {
        world.lifecycle.log.warn(
          `${name.toLowerCase()}.configuration_failed`,
          `${name} configuration failed; local riding remains available`,
        );

        return [];
      }),
    ),
  );

/** Acquire the server runtime into the current scope. Closing the scope releases everything in reverse
order: background work stops before the final flush, and the storage lock goes last.
*/
const acquireRuntime = Effect.fn('runtime.acquire')(function* (
  config: ResolvedConfig,
  assets: string,
  configPath?: string,
) {
  const release = yield* Effect.promise(() => new LockRepository().acquireStorageLock(config.storageDir));
  yield* releasing(release);

  const accounts = yield* Effect.acquireRelease(
    Effect.sync(() => AccountsService.open(config.storageDir)),
    (opened) => Effect.sync(() => opened.close()),
  );

  const settings = accounts.repositories.settingsRepository;
  yield* releasing(() => settings.close());
  const world = new World();

  const context: RepositoryContext = {
    config,
    assets,
    configPath,
    accounts,
    sessions: SessionsService.open(accounts),
    profiles: accounts.repositories.profileRepository,
    settings,
    world,
    tokens: Schema.decodeUnknownSync(tokensSchema)(
      JSON.parse(readFileSync(resolve(packageRoot(), '../assets/tokens.json'), 'utf8')),
    ),
  };

  const effects = yield* Effect.acquireRelease(
    Effect.sync(() => makeAppRuntime(context)),
    (opened) => Effect.promise(() => opened.dispose()),
  );

  const runtime: Runtime = Object.assign(context, { effects });
  yield* effects.runSync(ImportsService).recover();

  const simulation = new Simulation(runtime);
  const checkpoints = new CheckpointRepository(accounts.db, resolve(config.storageDir, 'zluggish.db'));
  yield* releasing(() => checkpoints.close());

  // Stops after the job runner and the simulation: the last flush covers their commits.
  const durability = effects.runSync(DurabilityService);
  yield* Effect.addFinalizer(() => durability.close());
  yield* releasing(async () => {
    await Promise.all((runtime.bridges ?? []).map((bridge) => bridge.close()));
  });
  const jobs = effects.runSync(JobsService);
  yield* Effect.addFinalizer(() => jobs.close());
  yield* releasing(() => simulation.close());
  const recovery = effects.runSync(RideRecoveryService);
  yield* Effect.addFinalizer(() => recovery.close());
  yield* releasing(() => world.lifecycle.close());
  const stopMetrics = yield* effects.runSync(MetricsService).start(config.logging.metricsIntervalSeconds);
  yield* releasing(stopMetrics);

  yield* Effect.promise(() => simulation.ready);
  simulation.start();

  yield* Effect.sleep(1000).pipe(
    Effect.andThen(effects.runSync(RideCompletionService).sweep()),
    Effect.forever,
    Effect.forkScoped,
  );

  yield* effects.runSync(TlsService).start();
  yield* durability.start();
  yield* recovery.start();
  yield* effects.runSync(UploadsService).start();
  yield* effects.runSync(RetentionService).schedule();
  yield* effects.runSync(BackupService).schedule();
  yield* effects.runSync(AppReleasesService).schedule();
  yield* jobs.start();
  checkpoints.start();

  const bridges = [
    ...(config.integrations.discord.enabled
      ? yield* optionalBridge(world, t('discord'), effects.runSync(DiscordService).start())
      : []),
    ...(config.integrations.matrix.enabled
      ? yield* optionalBridge(world, t('matrix'), effects.runSync(MatrixService).start())
      : []),
  ];

  runtime.bridges = bridges;

  if (bridges.length > 0) {
    world.presence = (id, joining) => {
      for (const bridge of bridges) {
        bridge.online(id, joining);
      }
    };
  }

  return runtime;
});

/** Open the server runtime. Close releases it once, however often it is called; a failed open releases
what it acquired before it rejects.
*/
export async function openRuntime(config: ResolvedConfig, assets: string, configPath?: string) {
  const resources = new Resources();

  try {
    const runtime = await Effect.runPromise(
      acquireRuntime(config, assets, configPath).pipe(Scope.provide(resources.scope)),
    );

    return { runtime, close: () => resources.close() };
  } catch (error) {
    try {
      await resources.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], t('runtime_initialization_cleanup_failed'), {
        cause: cleanupError,
      });
    }

    throw error;
  }
}
