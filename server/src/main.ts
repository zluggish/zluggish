import { Resources } from '#src/node/lifecycle/resources';
import { ConfigError } from '#src/config/index';
import type { LoadOptions } from '#src/config/load';
import { loadConfig, packageRoot, prepareContainerConfig } from '#src/config/load';
import { createApp } from '#src/http/app';
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
import { z } from 'zod';

const { values } = parseArgs({
  options: { config: { type: 'string' }, 'storage-dir': { type: 'string' } },
});

const options: LoadOptions = {};

if (values.config !== undefined) options.path = values.config;

if (values['storage-dir'] !== undefined) options.storageDir = values['storage-dir'];

const { config } = await loadConfig(prepareContainerConfig(options));

if (existsSync(resolve(config.storageDir, '.config-migration.json')))
  throw new ConfigError('Interrupted config migration; resume config migrate before starting');

const root = packageRoot();

const assets = resolve(root, '../assets');

const gameInfo = readFileSync(resolve(assets, 'data/game_info.txt'), 'utf8').replace(/^\u{FEFF}/u, '');

const gameInfoHash = z.object({ gameInfoHash: z.string() }).parse(JSON.parse(gameInfo)).gameInfoHash;

const variants = readFileSync(resolve(assets, 'data/variants.txt'), 'utf8');

await start();

async function start() {
  const resources = new Resources();

  try {
    const owner = await openRuntime(config, assets);
    resources.defer(() => owner.close());
    const app = createApp({ gameInfo, gameInfoHash, variants }, owner.runtime);
    const api = config.network.api;
    const host = api.host ?? config.network.host;
    const listener: HttpListenerOptions = { port: api.port, host };

    if (api.useCert)
      listener.tls = {
        cert: readFileSync(config.tls.certFile || resolve(assets, 'ssl/cert-zwift-com.pem')),
        key: readFileSync(config.tls.keyFile || resolve(assets, 'ssl/key-zwift-com.pem')),
      };

    const server = startHttp(app, listener);
    resources.defer(() => closeHttp(server));
    const cdn = startCdn(owner.runtime);
    resources.defer(() => closeHttp(cdn));
    const ride = startRideListeners(owner.runtime);
    resources.defer(() => ride.close());

    const dns = config.dns.enabled
      ? startDns(config.server.advertisedIp, config.network.host, 53, owner.runtime.world.lifecycle.log)
      : null;

    if (dns) resources.defer(() => dns.close());

    const log = owner.runtime.world.lifecycle.log;

    function closeHttp(listener: ReturnType<typeof startHttp>) {
      return new Promise<void>((resolve, reject) =>
        listener.close((error) => {
          if (error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')) reject(error);
          else resolve();
        }),
      );
    }

    const listeners = [server, cdn, ride.tcp, ride.udp, ...(dns ? [dns.socket] : [])];

    try {
      await Promise.all(listeners.map((listener) => once(listener, 'listening')));
      log.info('server.ready', 'Zluggish is ready', {
        host,
        port: api.port,
        tls: api.useCert,
        dns: !!dns,
        cdnPort: config.network.cdn.port,
        tcpPort: config.network.tcp.port,
        udpPort: config.network.udp.port,
      });
    } catch (error) {
      log.critical('server.start_failed', 'Required listener could not start', {
        error: error instanceof Error ? error : undefined,
      });
      throw new Error('Required listener could not start', { cause: error });
    }

    for (const listener of [server, cdn, ride.tcp])
      listener.on('error', () => {
        log.error('server.listener_failed', 'Network listener failed');
      });

    let state: 'ready' | 'stopping' | 'stopped' | 'failed' = 'ready';

    function shutdown() {
      if (state !== 'ready') return;
      state = 'stopping';
      log.info('server.stopping', 'Zluggish is stopping');

      const timer = setTimeout(() => {
        if ('closeAllConnections' in server) server.closeAllConnections();

        if ('closeAllConnections' in cdn) cdn.closeAllConnections();
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
        .catch(() => {
          clearTimeout(timer);
          state = 'failed';
          log.error('server.stop_failed', 'Shutdown failed');
          process.exitCode = 1;
        });
    }

    process.once('SIGINT', shutdown);

    process.once('SIGTERM', shutdown);
  } catch (error) {
    try {
      await resources.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Server startup and cleanup failed', { cause: cleanupError });
    }

    throw error;
  }
}
