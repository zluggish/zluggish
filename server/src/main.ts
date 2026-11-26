import { t } from '#src/i18n/index';
import { ManagementService } from '#src/services/management.service';
import { TlsService } from '#src/services/tls.service';
import { Resources } from '#src/node/lifecycle/resources';
import { ConfigError } from '#src/config/index';
import type { LoadOptions } from '#src/config/load';
import { loadConfig, packageRoot, prepareContainerConfig } from '#src/config/load';
import { createWebApp } from '#src/http/web-app';
import { createGameApp } from '#src/http/app';
import { startCdn } from '#src/node/network/cdn';
import { startDns } from '#src/node/network/dns';
import type { HttpListenerOptions } from '#src/node/network/http';
import { startHttp } from '#src/node/network/http';
import { startRideListeners } from '#src/node/network/ride';
import { openRuntime } from '#src/runtime';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Effect, Schema, Scope } from 'effect';

const { values } = parseArgs({
  options: { config: { type: 'string' }, 'storage-dir': { type: 'string' } },
});

const options: LoadOptions = {};

if (values.config !== undefined) {
  options.path = values.config;
}

if (values['storage-dir'] !== undefined) {
  options.storageDir = values['storage-dir'];
}

const { config, path: configPath } = await loadConfig(prepareContainerConfig(options)).catch((error: unknown) => {
  if (!(error instanceof ConfigError)) {
    throw error;
  }
  console.error(`ConfigError: ${error.message}`);
  // This is the server CLI entry point; config failure must stop before runtime startup.
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1);
});

if (existsSync(resolve(config.storageDir, '.config-migration.json'))) {
  throw new ConfigError(t('main_config_migration_incomplete'));
}

const root = packageRoot();

const assets = resolve(root, '../assets');

const gameInfo = readFileSync(resolve(assets, 'data/game_info.txt'), 'utf8').replace(/^\u{FEFF}/u, '');

const gameInfoHash = Schema.decodeUnknownSync(Schema.Struct({ gameInfoHash: Schema.String }))(
  JSON.parse(gameInfo),
).gameInfoHash;

const variants = readFileSync(resolve(assets, 'data/variants.txt'), 'utf8');

/** Close an HTTP listener; one that never started counts as closed. */
function closeHttp(listener: ReturnType<typeof startHttp>) {
  return new Promise<void>((resolve, reject) => {
    listener.close((error) => {
      if (error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

const listening = <A>(
  open: () => A,
  close: (listener: A) => void | Promise<void>,
): Effect.Effect<A, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.sync(open), (listener) =>
    Effect.promise(async () => {
      await close(listener);
    }),
  );

const serve = Effect.fn('server.start')(function* () {
  const webConfig = config.network.web;

  if (
    webConfig.enabled &&
    [
      config.network.api.port,
      config.network.cdn.port,
      config.network.tcp.port,
      config.network.udp.port,
      ...(config.dns.enabled ? [53] : []),
    ].includes(webConfig.port)
  ) {
    throw new ConfigError(t('main_web_port_conflict'));
  }

  const owner = yield* Effect.acquireRelease(
    Effect.promise(() => openRuntime(config, assets, configPath)),
    (opened) => Effect.promise(() => opened.close()),
  );

  const app = createGameApp({ gameInfo, gameInfoHash, variants }, owner.runtime);
  const api = config.network.api;
  const host = api.host ?? config.network.host;
  const listener: HttpListenerOptions = { port: api.port, host };

  const tls = owner.runtime.effects.runSync(TlsService);
  const material = tls.material();

  if (!material) {
    throw new ConfigError(t('main_tls_certificate_required'));
  }
  listener.tls = material;

  const server = yield* listening(() => startHttp(app, listener), closeHttp);

  // A rotated certificate applies to new connections at once; open ones keep the old one until they close.
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      tls.subscribe((next) => {
        if ('setSecureContext' in server) {
          server.setSecureContext(next);
        }
      }),
    ),
    (stop) => Effect.sync(stop),
  );

  const setupKey = webConfig.enabled
    ? owner.runtime.effects.runSync(ManagementService.use((management) => management.issueSetupKey()))
    : null;

  const web = webConfig.enabled
    ? yield* listening(
        () =>
          startHttp(createWebApp(owner.runtime), {
            host: webConfig.host ?? config.network.host,
            port: webConfig.port,
            // Allow large Android bundles on slower connections.
            requestTimeout: 2 * 60 * 60 * 1000,
          }),
        closeHttp,
      )
    : null;

  const cdn = yield* listening(() => startCdn(owner.runtime), closeHttp);

  const ride = yield* listening(
    () => startRideListeners(owner.runtime),
    (opened) => opened.close(),
  );

  const dns = config.dns.enabled
    ? yield* listening(
        () => startDns(config.server.advertisedIp, config.network.host, 53, owner.runtime.world.lifecycle.log),
        (opened) => opened.close(),
      )
    : null;

  const log = owner.runtime.world.lifecycle.log;

  if (config.accounts.allowSelfRegistration !== undefined) {
    log.warn(
      'config.deprecated',
      'accounts.allowSelfRegistration is deprecated and ignored. Only an administrator creates riders, in the web app. Remove it from the configuration.',
    );
  }

  const listeners = [server, cdn, ...(web ? [web] : []), ride.tcp, ride.udp, ...(dns ? [dns.socket] : [])];

  yield* Effect.tryPromise({
    try: () => Promise.all(listeners.map((socket) => once(socket, 'listening'))),
    catch: (error) => {
      log.critical('server.start_failed', t('main_listener_start_failed'), {
        error: error instanceof Error ? error : String(error),
      });

      return new Error(t('main_listener_start_failed'), { cause: error });
    },
  });

  if (tls.mode() === 'legacy') {
    console.log('Zwift traffic, passwords included, can be read on this network. Use a trusted network only.');
  }

  if (web) {
    const bind = webConfig.host ?? config.network.host;

    const address =
      webConfig.publicUrl ??
      `http://${bind === '0.0.0.0' || bind === '::' ? config.server.advertisedIp : bind.includes(':') ? `[${bind}]` : bind}:${webConfig.port}`;

    console.log(`Web app: ${address}`);

    if (!webConfig.publicUrl?.startsWith('https:') && !['127.0.0.1', '::1', 'localhost'].includes(bind)) {
      console.log('The web app sends passwords over the network without encryption.');
    }

    if (setupKey) {
      console.log(
        `============================================================\nZluggish first-time setup\nOpen: ${address}/setup\nSetup key: ${setupKey}\nValid until setup is complete or the server stops.\n============================================================`,
      );
    }
  }

  log.info('server.ready', 'Zluggish is ready', {
    host,
    port: api.port,
    tls: tls.mode(),
    dns: !!dns,
    cdnPort: config.network.cdn.port,
    tcpPort: config.network.tcp.port,
    udpPort: config.network.udp.port,
  });

  for (const socket of [server, cdn, ride.tcp, ...(web ? [web] : [])]) {
    socket.on('error', (error) => {
      log.error('server.listener_failed', 'Network listener failed', { error });
    });
  }

  return { log, server, web, cdn };
});

await start();

async function start() {
  const resources = new Resources();

  try {
    const { log, server, web, cdn } = await Effect.runPromise(serve().pipe(Scope.provide(resources.scope)));
    let state: 'ready' | 'stopping' | 'stopped' | 'failed' = 'ready';

    function shutdown() {
      if (state !== 'ready') {
        return;
      }
      state = 'stopping';
      log.info('server.stopping', 'Zluggish is stopping');

      const timer = setTimeout(() => {
        if ('closeAllConnections' in server) {
          server.closeAllConnections();
        }

        if (web && 'closeAllConnections' in web) {
          web.closeAllConnections();
        }

        if ('closeAllConnections' in cdn) {
          cdn.closeAllConnections();
        }
        log.error('server.stop_timeout', 'Shutdown timed out');
        process.exitCode = 1;
      }, 5000);

      timer.unref();
      void resources
        .close()
        .then(() => {
          clearTimeout(timer);
          state = 'stopped';
          log.info('server.stopped', 'Zluggish stopped');
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          state = 'failed';
          log.error('server.stop_failed', 'Shutdown failed', { error: error instanceof Error ? error : String(error) });
          process.exitCode = 1;
        });
    }

    process.once('SIGINT', shutdown);

    process.once('SIGTERM', shutdown);
  } catch (error) {
    try {
      await resources.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], t('main_startup_cleanup_failed'), {
        cause: cleanupError,
      });
    }

    throw error;
  }
}
