import { request as httpsRequest } from 'node:https';
// Container check of the production build on legacy storage: storage merge, legacy
// cleanup, backup, restore with the upload pause, server start and clean shutdown.
// Run: docker run --rm -i --read-only --tmpfs /tmp --entrypoint node zluggish:test --input-type=module < server/scripts/smoke-storage.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { completionSchemaSQL, createSchemaSQL } = await import(resolve('dist/src/db/ddl.js'));
const { SCHEMA_VERSION } = await import(resolve('dist/src/db/open.js'));
const storage = '/tmp/legacy-storage';
const backup = '/tmp/legacy-backup';
const config = '/tmp/storage-config/zluggish.config.ts';

mkdirSync('/tmp/storage-config');

writeFileSync(
  config,
  `export default {storageDir:${JSON.stringify(storage)},network:{host:"127.0.0.1",api:{port:25443,useCert:true},cdn:{port:25080},tcp:{port:25025},udp:{port:25024}}}`,
);

// A version 5 storage directory, as the previous release left it.
mkdirSync(resolve(storage, '1', 'bookmarks', '6', '0'), { recursive: true });
const legacy = new DatabaseSync(resolve(storage, 'zluggish.db'));
legacy.exec(createSchemaSQL);
legacy.exec(completionSchemaSQL);
legacy.exec(`INSERT INTO version VALUES (5); INSERT INTO account_state VALUES (1, 1);
  INSERT INTO user (player_id, username, first_name, last_name, is_admin) VALUES (1, 'one', 'One', 'Rider', 1);
  INSERT INTO activity (id, player_id, name) VALUES (10, 1, 'Done');
  INSERT INTO activity_upload VALUES (10, 'runalyze', 'sending'), (10, 'intervals', 'pending');`);
legacy.close();
writeFileSync(resolve(storage, '1', 'runalyze_token.txt'), 'token');
writeFileSync(resolve(storage, '1', 'streaks.bin'), new Uint8Array([8, 1]));
writeFileSync(resolve(storage, '1', 'bookmarks', '6', '0', 'Home.bin'), new Uint8Array([]));

function zluggish(...args) {
  const result = spawnSync('zluggish', ['--config', config, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `zluggish ${args.join(' ')}\n${result.stdout}${result.stderr}`);

  return result.stdout;
}

// The first database open migrates: usage reports the merged database.
const usage = JSON.parse(zluggish('storage', 'usage'));
assert.ok(usage.database > 0);
const db = new DatabaseSync(resolve(storage, 'zluggish.db'), { readOnly: true });
assert.equal(db.prepare('SELECT version FROM version').get().version, SCHEMA_VERSION);
assert.equal(db.prepare("SELECT state FROM activity_upload WHERE provider='runalyze'").get().state, 'ambiguous');
assert.equal(db.prepare('SELECT count(*) AS n FROM rider_document WHERE player_id=1').get().n, 2);
db.close();

assert.match(zluggish('storage', 'clean-legacy'), /3 legacy files can be removed/);
assert.ok(existsSync(resolve(storage, '1', 'runalyze_token.txt')));
assert.match(zluggish('storage', 'clean-legacy', '--confirm'), /3 legacy files removed/);
assert.equal(existsSync(resolve(storage, '1', 'runalyze_token.txt')), false);
assert.equal(existsSync(resolve(storage, '1', 'bookmarks')), false);

assert.match(zluggish('storage', 'backup', '--output', backup), /Backup complete/);
assert.match(zluggish('storage', 'restore', '--input', backup), /Restore complete/);
assert.match(zluggish('uploads', 'list'), /Uploads are paused[\s\S]*activity 10 intervals pending/);

// The server starts on the restored storage, keeps the pause, and stops cleanly.
const server = spawn(process.execPath, ['dist/src/main.js', '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
server.stdout.on('data', (bytes) => (output += bytes));
server.stderr.on('data', (bytes) => (output += bytes));
const exited = once(server, 'exit');

try {
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`Server readiness timeout\n${output}`)), 60_000);
    server.stdout.on('data', () => {
      if (output.includes('server.ready')) {
        clearTimeout(timer);
        done();
      }
    });
    server.once('exit', (code) => fail(new Error(`Server exited: ${code}\n${output}`)));
  });

  assert.match(output, /upload\.paused/);
  const health = await gameFetch('https://127.0.0.1:25443/health', { signal: AbortSignal.timeout(10_000) });
  assert.equal(health.status, 200);
  server.kill('SIGTERM');
  const [code] = await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Shutdown timeout\n${output}`)), 8000).unref()),
  ]);
  assert.equal(code, 0, output);
} finally {
  if (server.exitCode === null) server.kill('SIGKILL');
}

// Shutdown truncates the WAL; offline commands still see every row.
const wal = resolve(storage, 'zluggish.db-wal');
assert.ok(!existsSync(wal) || statSync(wal).size === 0, 'the WAL is truncated at shutdown');
assert.match(zluggish('uploads', 'list'), /activity 10 intervals pending/);
assert.ok(readFileSync(resolve(storage, 'storage-migration.json'), 'utf8').includes('"published"'));
console.log('Storage smoke: migration, legacy cleanup, backup, restore, pause and shutdown passed');

// Exercise the local self-signed game listener without changing global TLS verification.
function gameFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { ...init, rejectUnauthorized: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve(
          new Response(Buffer.concat(chunks), {
            status: response.statusCode,
            headers: response.headers,
          }),
        ),
      );
    });
    request.on('error', reject);
    request.end(init.body);
  });
}
