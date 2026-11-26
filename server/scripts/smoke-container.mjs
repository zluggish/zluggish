import { request as httpsRequest } from 'node:https';
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
  'export default {storageDir:"/usr/src/app/zluggish/storage",network:{host:"127.0.0.1",api:{port:24443,useCert:true},cdn:{port:24080},tcp:{port:23025},udp:{port:23024}}}',
);

chmodSync(file, 0o444);

const child = spawn(process.execPath, ['dist/src/main.js', '--config', file], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let errors = '';
let startupOutput = '';
child.stdout.on('data', (bytes) => {
  startupOutput += bytes;
});

child.stderr.on('data', (bytes) => (errors += bytes));

const exited = once(child, 'exit');

try {
  await waitForReady(child);
  const health = await gameFetch('https://127.0.0.1:24443/health', { signal: AbortSignal.timeout(10_000) });
  assert.equal(health.status, 200, errors);
  assert.equal((await gameFetch('https://127.0.0.1:24443/api/game_info')).status, 200);
  assert.equal((await fetch('http://127.0.0.1:24080/gameassets/Zwift_Updates_Root/Zwift_ver_cur.xml')).status, 200);
  assert.ok(existsSync('/usr/src/app/zluggish/storage/zluggish.db'));

  let cookie = '';
  async function uiRequest(path, init = {}) {
    const response = await gameFetch(`https://127.0.0.1:24443${path}`, {
      ...init,
      redirect: 'manual',
      headers: { Cookie: cookie, ...init.headers },
    });
    cookie = response.headers.getSetCookie().at(-1)?.split(';', 1)[0] ?? cookie;
    return response;
  }
  function token(html) {
    const value = /name="csrf_token"\s+value="([^"]+)"/.exec(html)?.[1];
    assert.ok(value);
    return value;
  }
  const state = await fetch('http://127.0.0.1:8080/api/setup');
  const stateBody = await state.json();
  const webCookie = state.headers.getSetCookie().at(-1)?.split(';', 1)[0];
  const key = /Setup key: ([A-Z0-9-]+)/.exec(startupOutput)?.[1];
  assert.ok(key);
  const setup = await fetch('http://127.0.0.1:8080/api/setup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: webCookie,
      Origin: 'http://127.0.0.1:8080',
      'X-CSRF-Token': stateBody.csrf,
    },
    body: JSON.stringify({
      mode: 'new',
      key,
      username: 'container',
      first_name: 'Container',
      last_name: 'Rider',
      password: 'container-password',
    }),
  });
  assert.equal(setup.status, 200, await setup.text());
  assert.equal((await uiRequest('/riders/add/')).status, 403);
  for (const path of ['/setup', '/manage/users/1', '/settings']) {
    const page = await fetch(`http://127.0.0.1:8080${path}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /assets\/index-.*\.js/);
  }
  const picker = await uiRequest('/login/');
  const pickerHtml = await picker.text();
  const playerId = /name="player_id"\s+value="(\d+)"/.exec(pickerHtml)?.[1];
  assert.ok(playerId);
  const selected = await uiRequest('/login/', {
    method: 'POST',
    body: new URLSearchParams({
      csrf_token: token(pickerHtml),
      player_id: playerId,
      step: 'password',
      password: 'container-password',
    }),
  });
  assert.equal(selected.status, 302);
  const prototype = await uiRequest(selected.headers.get('Location'));
  assert.equal(prototype.status, 200);
  assert.match(prototype.headers.get('content-type'), /text\/html/);
  const prototypeHtml = await prototype.text();
  for (const [pattern, mime] of [
    [/src="(\/static\/launcher-ui\/[^"]+\.js)"/, /text\/javascript/],
    [/href="(\/static\/launcher-ui\/[^"]+\.css)"/, /text\/css/],
  ]) {
    const path = pattern.exec(prototypeHtml)?.[1];
    assert.ok(path);
    const asset = await uiRequest(path);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), mime);

    // Every file the stylesheet references (fonts, logo, background) must be bundled and served.
    if (path.endsWith('.css'))
      for (const [, reference] of (await asset.text()).matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
        if (reference.startsWith('data:')) continue;
        const url = new URL(reference, `http://127.0.0.1:24443${path}`);
        const bundled = await uiRequest(url.pathname);
        assert.equal(bundled.status, 200, `${reference} from ${path}`);
        await bundled.arrayBuffer();
      }
  }

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

// Exercise the local self-signed game listener without changing global TLS verification.
async function gameFetch(url, init = {}) {
  // A Request encodes the body (such as URLSearchParams) and its Content-Type the way fetch does.
  const outgoing = new Request(url, init);
  const body = outgoing.body ? Buffer.from(await outgoing.arrayBuffer()) : undefined;

  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: outgoing.method,
        headers: Object.fromEntries(outgoing.headers),
        signal: init.signal,
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          // Node joins nothing, so each Set-Cookie stays separate for getSetCookie().
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers))
            for (const item of [value].flat()) headers.append(name, item);
          const empty = [101, 204, 205, 304].includes(response.statusCode);
          resolve(new Response(empty ? null : Buffer.concat(chunks), { status: response.statusCode, headers }));
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}
