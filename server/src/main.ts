import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig, packageRoot } from '#src/config/load';
import type { LoadOptions } from '#src/config/load';
import { ConfigError } from '#src/config/index';
import { startHttp } from '#src/node/network/http';
import type { HttpListenerOptions } from '#src/node/network/http';
import { openRuntime } from '#src/runtime';
import { startRideListeners } from '#src/node/network/ride';
import { startCdn } from '#src/node/network/cdn';
import { startDns } from '#src/node/network/dns';
import { createApp } from '#src/http/app';

const { values } = parseArgs({
  options: { config: { type: 'string' }, 'storage-dir': { type: 'string' } },
});

const options: LoadOptions = {};

if (values.config !== undefined) options.path = values.config;

if (values['storage-dir'] !== undefined) options.storageDir = values['storage-dir'];

const { config } = await loadConfig(options);

if (existsSync(resolve(config.storageDir, '.config-migration.json')))
  throw new ConfigError('Interrupted config migration; resume config migrate before starting');

const root = packageRoot();

const assets = resolve(root, 'assets');

const gameInfo = readFileSync(resolve(assets, 'data/game_info.txt'), 'utf8').replace(/^\u{FEFF}/u, '');

const gameInfoHash = z.object({ gameInfoHash: z.string() }).parse(JSON.parse(gameInfo)).gameInfoHash;

const variants = readFileSync(resolve(assets, 'data/variants.txt'), 'utf8');
const owner = await openRuntime(config, assets);
const app = createApp({ gameInfo, gameInfoHash, variants }, owner.runtime);
const api = config.network.api;
const host = api.host ?? (config.network.host || '0.0.0.0');
const listener: HttpListenerOptions = { port: api.port, host };

if (api.useCert)
  listener.tls = {
    cert: readFileSync(config.tls.certFile || resolve(assets, 'ssl/cert-zwift-com.pem')),
    key: readFileSync(config.tls.keyFile || resolve(assets, 'ssl/key-zwift-com.pem')),
  };

const server = startHttp(app, listener);
const cdn = startCdn(owner.runtime);
const ride = startRideListeners(owner.runtime);

const dns = config.dns.enabled ? startDns(config.server.advertisedIp, config.network.host || '0.0.0.0') : null;

console.log(`Zluggish server: ${api.useCert ? 'https' : 'http'}://${host}:${api.port}`);

let stopping = false;

function shutdown() {
  if (stopping) return;
  stopping = true;
  ride.close();
  cdn.close();
  dns?.close();

  const timer = setTimeout(() => {
    if ('closeAllConnections' in server) server.closeAllConnections();
    process.exitCode = 1;
  }, 5000);

  timer.unref();
  server.close(() => {
    clearTimeout(timer);
    void owner.close();
  });
}

process.once('SIGINT', shutdown);

process.once('SIGTERM', shutdown);
