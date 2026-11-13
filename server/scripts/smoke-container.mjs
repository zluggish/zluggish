import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { get } from 'node:https';

assert.equal(spawnSync('python3', ['--version']).error?.code, 'ENOENT');

assert.equal(existsSync('legacy'), false);

const storageConfig = '/usr/src/app/zwift-offline/storage/zluggish.config.ts';
assert.equal(existsSync(storageConfig), false);

async function defaultStartup(expectedIp) {
  const server = spawn(process.execPath, ['dist/src/main.js'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  server.stderr.on('data', (bytes) => (errors += bytes));
  const exited = once(server, 'exit');

  try {
    let response;

    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(errors);

      try {
        response = await new Promise((done, fail) => {
          const request = get('https://127.0.0.1/relay/tcp-config', { rejectUnauthorized: false }, (incoming) => {
            const chunks = [];
            incoming.on('data', (chunk) => chunks.push(chunk));
            incoming.on('end', () => done(Buffer.concat(chunks)));
            incoming.on('error', fail);
          });
          request.on('error', fail);
        });
        break;
      } catch {}

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.ok(response, errors);
    assert.ok(response.includes(Buffer.from(expectedIp)));
    server.kill('SIGTERM');
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Shutdown timeout')), 8000).unref()),
    ]);

    assert.equal(result[0], 0);
  } finally {
    if (server.exitCode === null) server.kill('SIGKILL');
  }
}

await defaultStartup('127.0.0.1');
assert.ok(existsSync(storageConfig));
const initialConfig = readFileSync(storageConfig, 'utf8');
const updatedConfig = initialConfig.replace('127.0.0.1', '192.0.2.25');
assert.notEqual(updatedConfig, initialConfig);
writeFileSync(storageConfig, updatedConfig);
await defaultStartup('192.0.2.25');
assert.equal(readFileSync(storageConfig, 'utf8'), updatedConfig);

const file = '/tmp/zluggish.config.ts';

writeFileSync(
  file,
  'export default {storageDir:"/usr/src/app/zwift-offline/storage",network:{host:"127.0.0.1",api:{port:24443,useCert:false},cdn:{port:24080},tcp:{port:23025},udp:{port:23024}}}',
);

chmodSync(file, 0o444);

const child = spawn(process.execPath, ['dist/src/main.js', '--config', file], {
  stdio: ['ignore', 'ignore', 'pipe'],
});

let errors = '';

child.stderr.on('data', (bytes) => (errors += bytes));

const exited = once(child, 'exit');

try {
  let ready = false;

  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(errors);

    try {
      const response = await fetch('http://127.0.0.1:24443/health');

      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.ok(ready, errors);
  assert.equal((await fetch('http://127.0.0.1:24443/api/game_info')).status, 200);
  assert.equal((await fetch('http://127.0.0.1:24080/gameassets/Zwift_Updates_Root/Zwift_ver_cur.xml')).status, 200);
  assert.ok(existsSync('/usr/src/app/zwift-offline/storage/zluggish.db'));
  child.kill('SIGTERM');

  const result = await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Shutdown timeout')), 8000).unref()),
  ]);

  assert.equal(result[0], 0);
  console.log('Node-only container: read-only root, external config, HTTP/CDN, storage and SIGTERM passed');
} finally {
  if (child.exitCode === null) child.kill('SIGKILL');
}
