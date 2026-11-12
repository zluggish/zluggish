import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadConfig } from '#src/config/load';
import { configSchema } from '#src/config/schema';
import { envBoolean, envInteger, defineConfig, validateConfig } from '#src/config/index';

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
  assert.equal(result.config.network.api.port, 443);
  assert.equal(result.config.riderDefaults.ghosts.enabled, false);
  assert.equal(result.config.soloBlob.riders, 8);
  assert.equal(defineConfig({ bots: { multiplier: 2 } }).bots.multiplier, 2);
});

await test('runtime validation rejects unknown, non-finite, invalid ranges and duplicate group IDs', () => {
  for (const input of [
    { server: { multiplayer: true } },
    { network: { api: { port: 0 } } },
    { bots: { multiplier: 101 } },
    { soloBlob: { rowGap: 0 } },
    { soloBlob: { riders: 31 } },
    { soloBlob: { rowGap: Infinity } },
    { pelotons: [{ id: 'x', pacer: 1, bots: 201 }] },
  ]) {
    assert.equal(configSchema.safeParse(input).success, false);
  }

  assert.throws(
    () =>
      validateConfig({
        pelotons: [
          { id: 'x', pacer: 1 },
          { id: 'x', pacer: 2 },
        ],
      }),
    /duplicate/,
  );
  assert.throws(() => envBoolean('yes'));
  assert.throws(() => envInteger('8e3', 1));
  assert.equal(envBoolean('false'), false);
  assert.equal(envInteger('8080', 1), 8080);
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
