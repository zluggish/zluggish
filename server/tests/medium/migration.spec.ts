import { readArchivedFile, withBackupDirectory } from '#src/migrations/backup-archive';
import { run } from '#src/cli/cli';
import { validateConfig } from '#src/config/index';
import { loadConfig, packageRoot } from '#src/config/load';
import { migrateConfig, migrationCandidate } from '#src/config/migrate';
import { openDatabase, SCHEMA_VERSION } from '#src/db/open';
import { LockRepository } from '#src/repositories/lock.repository';
import { SettingsStore } from '#src/repositories/settings.repository';
import { AccountsService } from '#src/services/auth.service';
import { SettingsService } from '#src/services/settings.service';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { test } from 'node:test';

function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'zluggish-migrate-'));
  const storage = resolve(root, 'storage');
  const stores: Array<SettingsStore> = [];
  mkdirSync(storage);
  t.after(() => {
    for (const store of stores) {
      store.close();
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  return {
    root,
    storage,
    output: resolve(root, 'external/zluggish.config.ts'),
    openSettings(readOnly = false) {
      const store = SettingsStore.legacy(storage, readOnly);
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
      if (!entry.isFile()) {
        return [];
      }
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
  writeFileSync(resolve(f.storage, 'unlock_bike_upgrades.txt'), '');
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
  const directory = resolve(f.storage, 'backups');
  const [name] = readdirSync(directory);
  assert.match(name!, /^config-migration-.*\.tar\.gz$/);
  const archive = resolve(directory, name!);
  assert.equal(readArchivedFile(archive, '42/profile.bin'), 'keep exact bytes');
  withBackupDirectory(archive, (snapshot) => assert.equal(existsSync(resolve(snapshot, 'settings.db')), false));
  const loaded = await loadConfig({ path: f.output });
  assert.equal(loaded.config.server.advertisedIp, '192.0.2.5');
  assert.equal(loaded.config.equipment.unlockBikeUpgrades, true);
  assert.equal(loaded.config.integrations.discord.channel, '1234567890123456789');
  assert.equal(loaded.config.integrations.discord.announcePlayers, true);
  assert.equal(loaded.config.soloBlob.riders, 12);
  assert.equal(loaded.config.pelotons[0]?.id, 'legacy-1');
  assert.equal(loaded.config.storageDir, f.storage);
  assert.equal(loaded.config.bots.ridersFile, resolve(f.storage, 'bot.txt'));
  assert.ok(!readFileSync(f.output, 'utf8').includes('do-not-copy-this-secret'));
  const store = f.openSettings(true);

  const settings = SettingsService.resolveRiderSettings(loaded.config.riderDefaults, store.read(42));

  assert.equal(settings.ghosts.enabled, true);
  assert.equal(settings.uploads.strava.method, 'free');
  assert.equal(store.read(43)['ghosts.enabled'], false);

  for (const [path, hex] of original) {
    assert.notEqual(path, undefined);
    assert.notEqual(hex, undefined);

    if (path === undefined || hex === undefined) {
      throw new Error('Invalid snapshot');
    }
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
  const store = SettingsStore.legacy(f.storage);
  store.save(42, { 'ghosts.enabled': false });
  store.close();
  unlinkSync(resolve(f.root, 'external'));
  await migrateConfig(f);
  assert.ok(existsSync(f.output));
  assert.ok(!existsSync(resolve(f.storage, '.config-migration.json')));
  const reopened = SettingsStore.legacy(f.storage, true);
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
    import { LockRepository } from './src/repositories/lock.repository.ts';
    const release = await new LockRepository().acquireStorageLock(process.argv[1]);
    process.stdin.on('end', async () => { await release(); });
    process.stdin.resume();
    process.stdout.write('ready\\n');
  `,
      f.storage,
    ],
    { cwd: packageRoot() },
  );

  const exited = new Promise<void>((done) => {
    child.once('close', () => done());
  });
  t.after(async () => {
    child.stdin.end();
    await exited;
  });
  await new Promise<void>((done, fail) => {
    child.stdout.once('data', () => done());
    child.once('error', fail);
    child.once('exit', (code) => {
      if (code) {
        fail(new Error('Lock contender failed'));
      }
    });
  });
  await assert.rejects(new LockRepository().acquireStorageLock(f.storage), /busy/);
});

await test('CLI migrates directly, validates and typechecks the externally generated module', async (t) => {
  const f = fixture(t);
  const messages: Array<string> = [];
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
  assert.equal(SettingsService.resolveRiderSettings(defaults, store.read(42)).ghosts.enabled, false);
  store.save(42, {});
  assert.equal(SettingsService.resolveRiderSettings(defaults, store.read(42)).ghosts.enabled, true);
  assert.throws(() => store.save(-1, {}));
});

await test('settings CLI dry runs do not create locks or a preference database', async (t) => {
  const f = fixture(t);
  addRiders(f.storage);
  renameSync(resolve(f.storage, 'zwift-offline.db'), resolve(f.storage, 'zluggish.db'));
  mkdirSync(resolve(f.root, 'external'));
  writeFileSync(f.output, `export default { storageDir: ${JSON.stringify(f.storage)} };`);
  const before = snapshot(f.root);

  const args = ['--config', f.output, 'settings', 'set', '--user', '42', 'ghosts.enabled', 'true'];

  await run([...args, '--dry-run'], () => {});
  assert.deepEqual(snapshot(f.root), before);
  await run(args, () => {});
  const store = SettingsStore.legacy(f.storage, true);
  assert.equal(store.read(42)['ghosts.enabled'], true);
  store.close();
  await run(['--config', f.output, 'settings', 'reset', '--user', '42', 'ghosts.enabled'], () => {});
  assert.equal(readFileSync(f.output, 'utf8'), `export default { storageDir: ${JSON.stringify(f.storage)} };`);
});

await test('preference conflicts fail even in dry run and leave existing settings intact', async (t) => {
  const f = fixture(t);
  addRiders(f.storage);
  const store = SettingsStore.legacy(f.storage);
  store.save(42, { 'ghosts.enabled': false });
  store.close();
  const before = snapshot(f.root);
  await assert.rejects(migrateConfig({ ...f, dryRun: true }), /Conflicting/);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(f.output), false);
});

await test('settings persist rider overrides across reopen and reject newer schemas', (t) => {
  const f = fixture(t);
  const store = SettingsStore.legacy(f.storage);
  store.save(42, { 'ghosts.enabled': true, 'uploads.strava.method': 'free' });
  store.close();
  const reopened = SettingsStore.legacy(f.storage);
  assert.deepEqual(reopened.read(42), { 'ghosts.enabled': true, 'uploads.strava.method': 'free' });
  assert.deepEqual(reopened.read(43), {});
  reopened.db.exec('PRAGMA user_version=2');
  reopened.close();
  assert.throws(() => SettingsStore.legacy(f.storage), /Unsupported/);
});

await test('account recovery uses config storage and honors an explicit storage override', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    run(['--config', f.output, 'accounts', 'recover', '--user', '1', '--password-file', 'unused.txt'], () => {}),
    /Missing/,
  );
  const configured = resolve(f.root, 'configured');
  const intended = AccountsService.open(configured);
  const user = await intended.create('Configured Rider', 'old');
  intended.close();
  const other = AccountsService.open(f.storage);
  const decoy = await other.create('Other Rider', 'unchanged');
  other.close();
  mkdirSync(resolve(f.root, 'external'));
  writeFileSync(f.output, `export default { storageDir: '../configured' };`);
  const passwordFile = resolve(f.root, 'password.txt');
  writeFileSync(passwordFile, 'new-password\n');
  await run(
    ['--config', f.output, 'accounts', 'recover', '--user', String(user.player_id), '--password-file', passwordFile],
    () => {},
  );
  const recovered = AccountsService.open(configured);
  const saved = recovered.get(user.player_id);
  assert.ok(saved);
  assert.equal(await recovered.verify(saved, 'new-password'), true);
  assert.equal(saved.auth_version, user.auth_version + 1);
  recovered.close();
  const untouched = AccountsService.open(f.storage);
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
      '--password-file',
      passwordFile,
    ],
    () => {},
  );
  const overridden = AccountsService.open(f.storage);
  const changed = overridden.get(decoy.player_id);
  assert.ok(changed);
  assert.equal(await overridden.verify(changed, 'new-password'), true);
  overridden.close();
});

await test('account migration uses the selected config storage', async (t) => {
  const f = fixture(t);
  const configured = resolve(f.root, 'configured');
  const accounts = AccountsService.open(configured);
  const user = await accounts.create('Legacy Rider', 'test-password');
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

  const migrated = AccountsService.open(configured);
  assert.equal(migrated.get(user.player_id)?.first_name, 'Legacy');
  migrated.close();
  assert.equal(existsSync(resolve(f.storage, 'zluggish.db')), false);
});

await test('version 12 adds launcher access groups to an existing database without touching riders', (t) => {
  const f = fixture(t);
  const created = openDatabase(f.storage);
  created.exec(`INSERT INTO user (player_id, username, first_name, last_name) VALUES (7, 'anna@example.com', 'Anna', 'Berg');
    DROP TABLE access_seen; DROP TABLE access_group_rider; DROP TABLE access_group_email; DROP TABLE access_group;
    UPDATE version SET version=11;`);
  created.close();

  const db = openDatabase(f.storage);
  t.after(() => db.close());
  assert.equal(SCHEMA_VERSION, 12);
  assert.equal(db.prepare('SELECT version FROM version').get()?.version, 12);
  assert.equal(db.prepare('SELECT username FROM user WHERE player_id=7').get()?.username, 'anna@example.com');
  // A schema-only migration takes no backup.
  assert.equal(existsSync(resolve(f.storage, 'backups')), false);

  db.exec(`INSERT INTO access_group (id, name) VALUES (1, 'Berg family');
    INSERT INTO access_group_email VALUES (1, 'Anna@Example.com');
    INSERT INTO access_group_rider VALUES (1, 7);`);
  assert.equal(db.prepare("SELECT count(*) AS n FROM access_group_email WHERE email='anna@example.com'").get()?.n, 1);
  assert.throws(() => db.exec('INSERT INTO access_group_rider VALUES (1, 99)'), /FOREIGN KEY/);
  db.exec('DELETE FROM user WHERE player_id=7');
  assert.equal(db.prepare('SELECT count(*) AS n FROM access_group_rider').get()?.n, 0);
  db.exec('DELETE FROM access_group');
  assert.equal(db.prepare('SELECT count(*) AS n FROM access_group_email').get()?.n, 0);
});
