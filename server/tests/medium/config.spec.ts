import { defineConfig, validateConfig } from '#src/config/index';
import { loadConfig, packageRoot, prepareContainerConfig } from '#src/config/load';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'zluggish-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  return root;
}

await test('external mounted config resolves helper and relative imports without node_modules', async (t) => {
  const root = fixture(t);
  writeFileSync(resolve(root, 'ghost.txt'), '{}');
  writeFileSync(resolve(root, 'values.ts'), 'export const multiplier = 7;');
  const path = resolve(root, 'zluggish.config.ts');
  writeFileSync(
    path,
    `import { defineConfig } from 'zluggish/config';
    import { multiplier } from './values.ts';
    export default defineConfig(({ env }) => ({ storageDir: './state', bots: { multiplier },
      server: { advertisedIp: env.TEST_IP }, ghosts: { profileFile: './ghost.txt' } }));`,
  );
  const loaded = await loadConfig({ path, env: { TEST_IP: '192.0.2.1' } });
  assert.equal(loaded.config.bots.multiplier, 7);
  assert.equal(loaded.config.server.advertisedIp, '192.0.2.1');
  assert.equal(loaded.config.storageDir, resolve(root, 'state'));
  assert.equal(loaded.config.ghosts.profileFile, resolve(root, 'ghost.txt'));
  assert.ok(Object.isFrozen(loaded.config.network.api));
  assert.deepEqual(readdirSync(root).sort(), ['ghost.txt', 'values.ts', 'zluggish.config.ts']);
});

await test('defaults and explicit bootstrap overrides are deterministic', async (t) => {
  const root = fixture(t);
  const path = resolve(root, 'zluggish.config.ts');
  writeFileSync(path, 'export default {}');

  const result = await loadConfig({
    path,
    storageDir: resolve(root, 'cli'),
    env: {
      ZLUGGISH_STORAGE_DIR: resolve(root, 'env'),
      ZOFFLINE_API_PORT: '1234',
    },
  });

  assert.equal(result.config.storageDir, resolve(root, 'cli'));
  assert.equal(result.config.network.host, '127.0.0.1');
  assert.equal(result.config.network.api.port, 443);
  assert.equal(validateConfig({ network: { host: '0.0.0.0' } }).network.host, '0.0.0.0');
  assert.equal(result.config.riderDefaults.ghosts.enabled, false);
  assert.equal(result.config.soloBlob.riders, 8);
  assert.equal(defineConfig({ bots: { multiplier: 2 } }).bots.multiplier, 2);
});

await test('container creates and loads its storage config without overwriting existing files', async (t) => {
  const root = fixture(t);
  const storage = resolve(root, 'storage');
  const env = { ZLUGGISH_CONTAINER_STORAGE_DIR: storage };
  const path = resolve(storage, 'zluggish.config.ts');
  const options = prepareContainerConfig({ env });
  assert.equal(options.path, path);
  assert.ok(existsSync(path));
  const initial = await loadConfig(options);
  assert.equal(initial.config.storageDir, storage);
  assert.equal(initial.config.network.host, '0.0.0.0');

  const updated = `export default { server: { advertisedIp: '192.0.2.25' }, network: { host: '0.0.0.0' } }`;
  writeFileSync(path, updated);
  const next = await loadConfig(prepareContainerConfig({ env }));
  assert.equal(next.config.server.advertisedIp, '192.0.2.25');
  assert.equal(readFileSync(path, 'utf8'), updated);

  writeFileSync(path, `export default { network: { host: '' } }`);
  await assert.rejects(loadConfig(prepareContainerConfig({ env })), /network\.host/);
});

await test('container respects explicit config and storage overrides', async (t) => {
  const root = fixture(t);
  const storage = resolve(root, 'default-storage');
  const customStorage = resolve(root, 'custom-storage');
  const explicit = resolve(root, 'external', 'zluggish.config.ts');
  const env = { ZLUGGISH_CONTAINER_STORAGE_DIR: storage };
  assert.equal(prepareContainerConfig({ path: explicit, env }).path, explicit);
  assert.equal(prepareContainerConfig({ env: { ...env, ZLUGGISH_CONFIG: explicit } }).path, undefined);
  assert.equal(existsSync(storage), false);
  const options = prepareContainerConfig({ storageDir: customStorage, env });
  assert.equal(options.path, resolve(customStorage, 'zluggish.config.ts'));
  const loaded = await loadConfig(options);
  assert.equal(loaded.config.storageDir, customStorage);
});

await test('invalid operator values and loader errors do not reveal secrets or create state', async (t) => {
  const root = fixture(t);
  const path = resolve(root, 'zluggish.config.ts');
  writeFileSync(path, `export default { bots: { multiplier: 'secret-value' } }`);
  await assert.rejects(
    loadConfig({ path }),
    (error) => error instanceof Error && !error.message.includes('secret-value'),
  );
  writeFileSync(path, `throw new Error('operator-secret');`);
  await assert.rejects(
    loadConfig({ path }),
    (error) => error instanceof Error && !error.message.includes('operator-secret'),
  );
  assert.deepEqual(readdirSync(root), ['zluggish.config.ts']);
});

await test('invalid network settings and unknown config keys fail at file load', async (t) => {
  const root = fixture(t);
  const path = resolve(root, 'zluggish.config.ts');
  writeFileSync(path, `export default { network: { host: '', tcp: { host: '' } } }`);
  await assert.rejects(loadConfig({ path }), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /network\.host: Expected a non-empty IP address or hostname/);
    assert.match(error.message, /network\.tcp\.host: Expected a non-empty IP address or hostname/);

    return true;
  });
  writeFileSync(path, `export default { userDefaults: {}, server: { advertisedIp: 'secret-value' } }`);
  await assert.rejects(loadConfig({ path }), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /server\.advertisedIp: Expected a non-wildcard IP address/);
    assert.match(error.message, /<root>: unrecognized_keys/);
    assert.doesNotMatch(error.message, /secret-value/);

    return true;
  });
});

await test('filename is explicit, async factories rejected, and successive loads do not use stale config', async (t) => {
  const root = fixture(t);
  const path = resolve(root, 'zluggish.config.ts');
  await assert.rejects(loadConfig({ path: resolve(root, 'config.jsonc') }), /named zluggish.config.ts/);
  writeFileSync(path, 'export default Promise.resolve({})');
  await assert.rejects(loadConfig({ path }));
  writeFileSync(path, 'export default async () => ({})');
  await assert.rejects(loadConfig({ path }));
  writeFileSync(path, 'export default { bots: { multiplier: 3 } }');
  const response1 = await loadConfig({ path });
  assert.equal(response1.config.bots.multiplier, 3);
  mkdirSync(resolve(root, 'state'));
  writeFileSync(path, 'export default { bots: { multiplier: 4 } }');
  const response2 = await loadConfig({ path });
  assert.equal(response2.config.bots.multiplier, 4);
});

await test('invalid real config files stop the server before creating runtime state', async (t) => {
  const cases = [
    ['missing file', null, /Missing .*zluggish\.config\.ts/],
    ['empty file', '', /<root>|Cannot evaluate/],
    ['missing default export', 'export const config = {};', /<root>|Cannot evaluate/],
    ['undefined export', 'export default undefined;', /<root>/],
    ['null export', 'export default null;', /<root>|Cannot evaluate/],
    ['array export', 'export default [];', /<root>/],
    ['invalid syntax', 'export default {', /Cannot evaluate/],
    ['async factory', 'export default async () => ({});', /Async configuration/],
    ['missing peloton ID', 'export default { pelotons: [{ pacer: 1 }] };', /pelotons\.0\.id/],
    ['missing pacer', "export default { pelotons: [{ id: 'group' }] };", /pelotons\.0\.pacer/],
    [
      'missing Discord credentials',
      'export default { integrations: { discord: { enabled: true } } };',
      /integrations\.discord\.credentialsFile/,
    ],
    ['blank storage', "export default { storageDir: '' };", /storageDir/],
    ['whitespace storage', "export default { storageDir: '   ' };", /storageDir/],
    ['blank group ID', "export default { pelotons: [{ id: ' ', pacer: 1 }] };", /pelotons\.0\.id/],
    ['blank pacer', "export default { pelotons: [{ id: 'group', pacer: '' }] };", /pelotons\.0\.pacer/],
    ['invalid pacer ID', "export default { pelotons: [{ id: 'group', pacer: 0 }] };", /pelotons\.0\.pacer/],
    ['blank domain', "export default { integrations: { garmin: { domain: '' } } };", /integrations\.garmin\.domain/],
    [
      'invalid domain',
      "export default { integrations: { garmin: { domain: 'https://garmin.com' } } };",
      /integrations\.garmin\.domain/,
    ],
    ['blank host', "export default { network: { host: ' ' } };", /network\.host/],
    ['invalid IP', "export default { server: { advertisedIp: '999.0.0.1' } };", /server\.advertisedIp/],
    ['unknown nested field', 'export default { network: { api: { prot: 443 } } };', /network\.api: unrecognized_keys/],
    ['unknown field', 'export default { typo: true };', /<root>: unrecognized_keys/],
    ['wrong boolean type', "export default { bots: { enabled: 'false' } };", /bots\.enabled/],
    ['null section', 'export default { network: null };', /network/],
    ['invalid port', 'export default { network: { api: { port: 65536 } } };', /network\.api\.port/],
    ['fractional port', 'export default { network: { tcp: { port: 1.5 } } };', /network\.tcp\.port/],
    ['nonfinite number', 'export default { soloBlob: { rowGap: Infinity } };', /soloBlob\.rowGap/],
    ['invalid enum', "export default { proxy: { mode: 'yes' } };", /proxy\.mode/],
    [
      'duplicate groups',
      "export default { pelotons: [{ id: 'x', pacer: 1 }, { id: 'x', pacer: 2 }] };",
      /duplicate group ID/,
    ],
    ['missing resource', "export default { ghosts: { profileFile: './missing.txt' } };", /ghosts\.profileFile/],
    ['directory resource', "export default { bots: { ridersFile: '.' } };", /bots\.ridersFile/],
    ['whitespace resource', "export default { ghosts: { profileFile: ' ' } };", /ghosts\.profileFile/],
    ['unpaired TLS', "export default { tls: { certFile: './cert.pem' } };", /tls\.certFile and tls\.keyFile/],
    [
      'invalid TLS contents',
      "export default { tls: { certFile: './zluggish.config.ts', keyFile: './zluggish.config.ts' } };",
      /tls: invalid certificate or private key/,
    ],
    ['missing TLS files', "export default { tls: { certFile: './cert.pem', keyFile: './key.pem' } };", /tls\.certFile/],
  ] as const;

  for (const [name, source, expected] of cases) {
    await t.test(name, () => {
      const root = fixture(t);
      const path = resolve(root, 'zluggish.config.ts');
      const storage = resolve(root, 'state');

      if (source !== null) writeFileSync(path, source);

      const result = spawnSync(
        process.execPath,
        ['--conditions=development', '--import', 'tsx', 'src/main.ts', '--config', path],
        {
          cwd: resolve(import.meta.dirname, '../..'),
          env: { ...process.env, ZLUGGISH_STORAGE_DIR: storage, ZLUGGISH_CONTAINER_STORAGE_DIR: '' },
          encoding: 'utf8',
          timeout: 10_000,
        },
      );

      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, expected);
      assert.doesNotMatch(result.stdout, /Zluggish server:/);
      assert.equal(existsSync(storage), false, 'configuration must fail before runtime creates storage');
      assert.deepEqual(readdirSync(root), source === null ? [] : ['zluggish.config.ts']);
    });
  }
});

await test('storage overrides and file paths are validated before path resolution', async (t) => {
  const root = fixture(t);
  const path = resolve(root, 'zluggish.config.ts');
  writeFileSync(path, 'export default {}');

  for (const storageDir of ['', ' ', '\0']) {
    await assert.rejects(loadConfig({ path, storageDir }), /storageDir/);
    await assert.rejects(loadConfig({ path, env: { ZLUGGISH_STORAGE_DIR: storageDir } }), /storageDir/);
  }

  const file = resolve(root, 'not-a-directory');
  writeFileSync(file, 'state');
  await assert.rejects(loadConfig({ path, storageDir: file }), /storageDir: expected a directory/);
});

await test('custom TLS files are resolved and validated without creating storage', async (t) => {
  const root = fixture(t);
  const path = resolve(root, 'zluggish.config.ts');
  const assets = resolve(packageRoot(), '../assets/ssl');
  writeFileSync(resolve(root, 'cert.pem'), readFileSync(resolve(assets, 'cert-zwift-com.pem')));
  writeFileSync(resolve(root, 'key.pem'), readFileSync(resolve(assets, 'key-zwift-com.pem')));
  writeFileSync(
    path,
    `export default { storageDir: './state', tls: { certFile: './cert.pem', keyFile: './key.pem' } }`,
  );
  const loaded = await loadConfig({ path });
  assert.equal(loaded.config.tls.certFile, resolve(root, 'cert.pem'));
  assert.equal(loaded.config.tls.keyFile, resolve(root, 'key.pem'));
  assert.equal(existsSync(loaded.config.storageDir), false);
});
