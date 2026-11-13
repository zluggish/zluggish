import { Accounts } from 'zluggish/internal/domain/accounts/repository';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  existsSync,
  unlinkSync,
  renameSync,
} from 'node:fs';
import { resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { migrateConfig, migrationCandidate } from 'zluggish/internal/config/migrate';
import { loadConfig, packageRoot } from 'zluggish/internal/config/load';
import { SettingsStore, resolveRiderSettings } from 'zluggish/internal/node/persistence/settings';
import { validateConfig } from 'zluggish/internal/config/index';
import { acquireStorageLock } from 'zluggish/internal/node/persistence/lock';
import { run } from '#cli/cli';

function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'zluggish-migrate-'));
  const storage = resolve(root, 'storage');
  const stores: SettingsStore[] = [];
  mkdirSync(storage);
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  });

  return {
    root,
    storage,
    output: resolve(root, 'external/zluggish.config.ts'),
    openSettings(readOnly = false) {
      const store = new SettingsStore(storage, readOnly);
      stores.push(store);

      return store;
    },
  };
}

function addRiders(storage: string) {
  const db = new DatabaseSync(resolve(storage, 'zwift-offline.db'));
  db.exec(
    'CREATE TABLE user (player_id INTEGER PRIMARY KEY, enable_ghosts INTEGER); INSERT INTO user VALUES (42, 1), (43, 0)',
  );
  db.close();
  mkdirSync(resolve(storage, '42'));
  writeFileSync(resolve(storage, '42/profile.bin'), 'keep exact bytes');
}

function snapshot(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .flatMap((entry) => {
      if (!entry.isFile()) return [];
      const path = resolve(entry.parentPath, entry.name);

      return [[relative(root, path), readFileSync(path).toString('hex')]];
    })
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

await test('dry run maps original markers and rider data without creating files', async (t) => {
  const f = fixture(t);
  addRiders(f.storage);
  writeFileSync(resolve(f.storage, 'server-ip.txt'), '192.0.2.42\n');
  writeFileSync(resolve(f.storage, 'enable_bots.txt'), '4');
  const before = snapshot(f.root);
  const result = await migrateConfig({ ...f, dryRun: true });
  assert.deepEqual(result.riders, [42, 43]);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(migrationCandidate(f).config.bots.multiplier, 4);
});

await test('direct migration generates loadable TS and preferences with no JSONC or source changes', async (t) => {
  const f = fixture(t);
  addRiders(f.storage);
  writeFileSync(resolve(f.storage, 'server-ip.txt'), '192.0.2.5');
  writeFileSync(resolve(f.storage, 'fake-dns.txt'), '');
  writeFileSync(resolve(f.storage, 'bot.txt'), '[]');
  writeFileSync(
    resolve(f.storage, 'discord.cfg'),
    '[discord]\nchannel=1234567890123456789\nannounce_players=true\ntoken=do-not-copy-this-secret\n',
  );
  writeFileSync(resolve(f.storage, '42/strava_upload_method.txt'), 'free');
  writeFileSync(resolve(f.storage, 'peloton.txt'), JSON.stringify({ pelotons: [{ pacer: 123, bots: 15 }] }));
  writeFileSync(resolve(f.storage, 'solo_blob.txt'), JSON.stringify({ enabled: true, riders: 12 }));
  const original = snapshot(f.storage);
  await migrateConfig(f);
  const loaded = await loadConfig({ path: f.output });
  assert.equal(loaded.config.server.advertisedIp, '192.0.2.5');
  assert.equal(loaded.config.integrations.discord.channel, '1234567890123456789');
  assert.equal(loaded.config.integrations.discord.announcePlayers, true);
  assert.equal(loaded.config.soloBlob.riders, 12);
  assert.equal(loaded.config.pelotons[0]?.id, 'legacy-1');
  assert.equal(loaded.config.storageDir, f.storage);
  assert.equal(loaded.config.bots.ridersFile, resolve(f.storage, 'bot.txt'));
  assert.ok(!readFileSync(f.output, 'utf8').includes('do-not-copy-this-secret'));
  const store = f.openSettings(true);

  const settings = resolveRiderSettings(loaded.config.riderDefaults, store.read(42));

  assert.equal(settings.ghosts.enabled, true);
  assert.equal(settings.uploads.strava.method, 'free');
  assert.equal(store.read(43)['ghosts.enabled'], false);

  for (const [path, hex] of original) {
    assert.notEqual(path, undefined);
    assert.notEqual(hex, undefined);

    if (path === undefined || hex === undefined) throw new Error('Invalid snapshot');
    assert.equal(readFileSync(resolve(f.storage, path)).toString('hex'), hex);
  }

  assert.ok(snapshot(f.root).every(([path]) => !(path?.endsWith('.jsonc') || path?.endsWith('.schema.json'))));
  await assert.rejects(migrateConfig(f), /Destination exists/);
});

await test('invalid input and ambiguous solo ownership fail before publication', async (t) => {
  const f = fixture(t);
  writeFileSync(resolve(f.storage, 'enable_bots.txt'), '-1');
  await assert.rejects(migrateConfig(f));
  assert.equal(existsSync(f.output), false);
  assert.equal(existsSync(resolve(f.storage, 'settings.db')), false);
  unlinkSync(resolve(f.storage, 'enable_bots.txt'));
  mkdirSync(resolve(f.storage, '7'));
  writeFileSync(resolve(f.storage, '7/profile.bin'), 'data');
  await assert.rejects(migrateConfig(f), /solo-player/);
  const candidate = migrationCandidate({ ...f, soloPlayer: 7 });
  assert.equal(candidate.preferences[0]?.playerId, 7);
});

await test('publication failure after database commit resumes without losing later overrides', async (t) => {
  const f = fixture(t);
  addRiders(f.storage);
  writeFileSync(resolve(f.root, 'external'), 'blocks destination directory');
  await assert.rejects(migrateConfig(f));
  assert.ok(existsSync(resolve(f.storage, '.config-migration.json')));
  const store = new SettingsStore(f.storage);
  store.save(42, { 'ghosts.enabled': false });
  store.close();
  unlinkSync(resolve(f.root, 'external'));
  await migrateConfig(f);
  assert.ok(existsSync(f.output));
  assert.ok(!existsSync(resolve(f.storage, '.config-migration.json')));
  const reopened = new SettingsStore(f.storage, true);
  assert.equal(reopened.read(42)['ghosts.enabled'], false);
  reopened.close();
});

await test('interrupted migration never overwrites a subsequently created config', async (t) => {
  const f = fixture(t);
  writeFileSync(resolve(f.root, 'external'), 'block');
  await assert.rejects(migrateConfig(f));
  unlinkSync(resolve(f.root, 'external'));
  mkdirSync(resolve(f.root, 'external'));
  writeFileSync(f.output, 'export default { bots: { multiplier: 3 } };');
  await assert.rejects(migrateConfig(f), /output changed/);
  assert.ok(readFileSync(f.output, 'utf8').includes('multiplier: 3'));
});

await test('independent Node processes contend on the storage OS lock', async (t) => {
  const f = fixture(t);

  const child = spawn(
    process.execPath,
    [
      '--conditions=development',
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '-e',
      `
    import { acquireStorageLock } from './src/node/persistence/lock.ts';
    const release = await acquireStorageLock(process.argv[1]);
    process.stdin.on('end', async () => { await release(); });
    process.stdin.resume();
    process.stdout.write('ready\\n');
  `,
      f.storage,
    ],
    { cwd: packageRoot() },
  );

  const exited = new Promise<void>((done) => child.once('close', () => done()));
  t.after(async () => {
    child.stdin.end();
    await exited;
  });
  await new Promise<void>((done, fail) => {
    child.stdout.once('data', () => done());
    child.once('error', fail);
    child.once('exit', (code) => {
      if (code) fail(new Error('Lock contender failed'));
    });
  });
  await assert.rejects(acquireStorageLock(f.storage), /busy/);
});

await test('CLI migrates directly, validates and typechecks the externally generated module', async (t) => {
  const f = fixture(t);
  const messages: string[] = [];
  assert.equal(
    await run(['--storage-dir', f.storage, 'config', 'migrate', '--output', f.output], (message) => {
      messages.push(message);
    }),
    0,
  );
  assert.equal(
    await run(['--config', f.output, 'config', 'validate'], (message) => {
      messages.push(message);
    }),
    0,
  );
  assert.equal(
    await run(['--config', f.output, 'config', 'typecheck'], (message) => {
      messages.push(message);
    }),
    0,
  );
  assert.ok(messages.some((message) => message.startsWith('Valid:')));
});

await test('preference reset exposes configured defaults and invalid writes fail validation', (t) => {
  const f = fixture(t);
  const store = f.openSettings();

  const defaults = validateConfig({
    riderDefaults: { ghosts: { enabled: true } },
  }).riderDefaults;

  store.save(42, { 'ghosts.enabled': false });
  assert.equal(resolveRiderSettings(defaults, store.read(42)).ghosts.enabled, false);
  store.save(42, {});
  assert.equal(resolveRiderSettings(defaults, store.read(42)).ghosts.enabled, true);
  assert.throws(() => store.save(-1, {}));
});

await test('settings CLI dry runs do not create locks or a preference database', async (t) => {
  const f = fixture(t);
  addRiders(f.storage);
  mkdirSync(resolve(f.root, 'external'));
  writeFileSync(f.output, `export default { storageDir: ${JSON.stringify(f.storage)} };`);
  const before = snapshot(f.root);

  const args = ['--config', f.output, 'settings', 'set', '--user', '42', 'ghosts.enabled', 'true'];

  await run([...args, '--dry-run'], () => {});
  assert.deepEqual(snapshot(f.root), before);
  await run(args, () => {});
  const store = new SettingsStore(f.storage, true);
  assert.equal(store.read(42)['ghosts.enabled'], true);
  store.close();
  await run(['--config', f.output, 'settings', 'reset', '--user', '42', 'ghosts.enabled'], () => {});
  assert.equal(readFileSync(f.output, 'utf8'), `export default { storageDir: ${JSON.stringify(f.storage)} };`);
});

await test('preference conflicts fail even in dry run and leave existing settings intact', async (t) => {
  const f = fixture(t);
  addRiders(f.storage);
  const store = new SettingsStore(f.storage);
  store.save(42, { 'ghosts.enabled': false });
  store.close();
  const before = snapshot(f.root);
  await assert.rejects(migrateConfig({ ...f, dryRun: true }), /Conflicting/);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(f.output), false);
});

await test('settings persist rider overrides across reopen and reject newer schemas', (t) => {
  const f = fixture(t);
  const store = new SettingsStore(f.storage);
  store.save(42, { 'ghosts.enabled': true, 'uploads.strava.method': 'free' });
  store.close();
  const reopened = new SettingsStore(f.storage);
  assert.deepEqual(reopened.read(42), { 'ghosts.enabled': true, 'uploads.strava.method': 'free' });
  assert.deepEqual(reopened.read(43), {});
  reopened.db.exec('PRAGMA user_version=2');
  reopened.close();
  assert.throws(() => new SettingsStore(f.storage), /Unsupported/);
});

await test('account recovery uses config storage and honors an explicit storage override', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    run(['--config', f.output, 'accounts', 'recover', '--user', '1', '--remove-password'], () => {}),
    /Missing/,
  );
  const configured = resolve(f.root, 'configured');
  const intended = new Accounts(configured);
  const user = await intended.create('Configured Rider', 'old', true);
  intended.close();
  const other = new Accounts(f.storage);
  const decoy = await other.create('Other Rider', 'unchanged', true);
  other.close();
  mkdirSync(resolve(f.root, 'external'));
  writeFileSync(f.output, `export default { storageDir: '../configured' };`);
  const passwordFile = resolve(f.root, 'password.txt');
  writeFileSync(passwordFile, 'new-password\n');
  await run(
    ['--config', f.output, 'accounts', 'recover', '--user', String(user.player_id), '--password-file', passwordFile],
    () => {},
  );
  const recovered = new Accounts(configured);
  const saved = recovered.get(user.player_id);
  assert.ok(saved);
  assert.equal(await recovered.verify(saved, 'new-password'), true);
  assert.equal(saved.auth_version, user.auth_version + 1);
  recovered.close();
  const untouched = new Accounts(f.storage);
  const stillThere = untouched.get(decoy.player_id);
  assert.ok(stillThere);
  assert.equal(await untouched.verify(stillThere, 'unchanged'), true);
  untouched.close();
  await run(
    [
      '--config',
      f.output,
      '--storage-dir',
      f.storage,
      'accounts',
      'recover',
      '--user',
      String(decoy.player_id),
      '--remove-password',
    ],
    () => {},
  );
  const overridden = new Accounts(f.storage);
  assert.equal(overridden.get(decoy.player_id)?.pass_hash, null);
  overridden.close();
});

await test('account migration uses the selected config storage', async (t) => {
  const f = fixture(t);
  const configured = resolve(f.root, 'configured');
  const accounts = new Accounts(configured);
  const user = await accounts.create('Legacy Rider', '', true);
  accounts.close();
  renameSync(resolve(configured, 'zluggish.db'), resolve(configured, 'zwift-offline.db'));
  mkdirSync(resolve(f.root, 'external'));
  writeFileSync(f.output, `export default { storageDir: '../configured' };`);
  const keepAlive = setInterval(() => {}, 1000);

  try {
    await run(['--config', f.output, 'accounts', 'migrate'], () => {});
  } finally {
    clearInterval(keepAlive);
  }

  const migrated = new Accounts(configured);
  assert.equal(migrated.get(user.player_id)?.first_name, 'Legacy');
  migrated.close();
  assert.equal(existsSync(resolve(f.storage, 'zluggish.db')), false);
});
