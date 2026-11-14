import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { get } from 'node:https';

assert.equal(spawnSync('python3', ['--version']).error?.code, 'ENOENT');

assert.equal(existsSync('legacy'), false);

// Exercise the installed admin command with production dependencies only.
const help = spawnSync('zluggish', ['--help'], { encoding: 'utf8' });
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /Usage: zluggish/);
const validate = spawnSync('zluggish', ['config', 'validate'], { encoding: 'utf8' });
assert.equal(validate.status, 0, validate.stderr);
const typecheck = spawnSync('zluggish', ['config', 'typecheck'], { encoding: 'utf8' });
assert.equal(typecheck.status, 0, typecheck.stdout + typecheck.stderr);

const storageConfig = '/usr/src/app/zluggish/storage/zluggish.config.ts';
assert.equal(existsSync(storageConfig), false);

// ARM64 runs under QEMU in CI. Wait for actual listener readiness, rather than
// assuming module loading and configuration evaluation finish within ten seconds.
function waitForReady(server) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error(`Server readiness timeout after 60s\n${output}`)), 60_000);
    const stdout = (bytes) => {
      output += bytes;
      if (output.includes('server.ready')) finish();
    };
    const stderr = (bytes) => {
      output += bytes;
    };
    const exit = (code, signal) => finish(new Error(`Server exited before readiness: ${code ?? signal}\n${output}`));
    const finish = (error) => {
      clearTimeout(timer);
      server.stdout.off('data', stdout);
      server.stderr.off('data', stderr);
      server.off('exit', exit);
      server.off('error', finish);
      if (error) reject(error);
      else resolve();
    };
    server.stdout.on('data', stdout);
    server.stderr.on('data', stderr);
    server.once('exit', exit);
    server.once('error', finish);
  });
}

async function defaultStartup(expectedIp) {
  const server = spawn(process.execPath, ['dist/src/main.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  server.stderr.on('data', (bytes) => (errors += bytes));
  const exited = once(server, 'exit');

  try {
    await waitForReady(server);
    const response = await new Promise((done, fail) => {
      const request = get(
        'https://127.0.0.1/relay/tcp-config',
        {
          rejectUnauthorized: false,
          signal: AbortSignal.timeout(10_000),
        },
        (incoming) => {
          const chunks = [];
          incoming.on('data', (chunk) => chunks.push(chunk));
          incoming.on('end', () => done(Buffer.concat(chunks)));
          incoming.on('error', fail);
        },
      );
      request.on('error', fail);
    });

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
const updatedConfig = initialConfig.replace('127.0.0.1', '192.0.2.25').replace('0.0.0.0', '127.0.0.1');
assert.notEqual(updatedConfig, initialConfig);
writeFileSync(storageConfig, updatedConfig);
await defaultStartup('192.0.2.25');
assert.equal(readFileSync(storageConfig, 'utf8'), updatedConfig);
const show = spawnSync('zluggish', ['config', 'show'], { encoding: 'utf8' });
assert.equal(show.status, 0, show.stderr);
assert.equal(JSON.parse(show.stdout).path, storageConfig);
assert.equal(JSON.parse(show.stdout).network.host, '127.0.0.1');

const file = '/tmp/zluggish.config.ts';

writeFileSync(
  file,
  'export default {storageDir:"/usr/src/app/zluggish/storage",network:{host:"127.0.0.1",api:{port:24443,useCert:false},cdn:{port:24080},tcp:{port:23025},udp:{port:23024}}}',
);

chmodSync(file, 0o444);

const child = spawn(process.execPath, ['dist/src/main.js', '--config', file], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let errors = '';

child.stderr.on('data', (bytes) => (errors += bytes));

const exited = once(child, 'exit');

try {
  await waitForReady(child);
  const health = await fetch('http://127.0.0.1:24443/health', { signal: AbortSignal.timeout(10_000) });
  assert.equal(health.status, 200, errors);
  assert.equal((await fetch('http://127.0.0.1:24443/api/game_info')).status, 200);
  assert.equal((await fetch('http://127.0.0.1:24080/gameassets/Zwift_Updates_Root/Zwift_ver_cur.xml')).status, 200);
  assert.ok(existsSync('/usr/src/app/zluggish/storage/zluggish.db'));
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
