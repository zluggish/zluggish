import { readArchivedFile, withBackupDirectory } from '#src/migrations/backup-archive';
import { Schema } from 'effect';
import { openDatabase } from '#src/db/open';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { PlayerProfileSchema, StreaksSchema } from '#src/protocol/generated/profile_pb';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { legacyPlan, removeLegacy } from '#src/migrations/legacy';
import { migrateStorage, MigrationStep, StorageFile } from '#src/migrations/storage';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { RiderDocuments } from '#src/repositories/rider-document.repository';
import { SettingsStore } from '#src/repositories/settings.repository';
import { StreakService } from '#src/services/streak.service';
import { legacyDatabase } from '#tests/support/legacy';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { test } from 'node:test';

const crypto = new CryptoRepository();
const fit = readFileSync(new URL('../fixtures/ride.fit', import.meta.url));
const key = crypto.randomBytes(32);

const activity = (id: number, name: string, extra: { fit?: Uint8Array } = {}) =>
  create(ActivitySchema, {
    id: BigInt(id),
    playerId: 1n,
    courseId: 6n,
    name,
    startDate: '2026-11-02T10:00:00Z',
    distanceInMeters: 3000,
    sport: 0,
    fitFilename: 'ride.fit',
    ...extra,
  });

const previous = create(StreaksSchema, { curStreak: 1, curStreakDistance: 1000, weekEnd: 1n });

// A profile with a 64-bit identifier and a field this release does not know (field 900,
// varint 7): the merge must keep the exact bytes.
const profile = Buffer.concat([
  toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 9_007_199_254_740_993n, firstName: 'One' })),
  Buffer.from([0xa0, 0x38, 0x07]),
]);

/** Legacy rider files and their database documents. */
const imported = [
  'profile.bin',
  'streaks.bin',
  'strava_token.txt',
  'runalyze_token.txt',
  'zwift_credentials.bin',
  'garth/oauth1_token.json',
] as const;

function write(storage: string, path: string, data: string | Uint8Array) {
  mkdirSync(resolve(storage, path, '..'), { recursive: true });
  writeFileSync(resolve(storage, path), data);
}

/** A version 5 storage directory with every legacy store the merge must import. */
function legacy(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'zluggish-legacy-'));
  const storage = resolve(root, 'storage');
  mkdirSync(storage);
  const databases: Array<DatabaseSync> = [];
  t.after(() => {
    for (const database of databases) {
      if (database.isOpen) {
        database.close();
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const db = legacyDatabase(storage);
  db.exec(`INSERT INTO user (player_id, username, first_name, last_name, pass_hash, auth_version, official_player_id, is_admin)
    VALUES (1, 'one', 'One', 'Rider', '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA', 3, 9007199254740993, 1),
    (2, 'two', 'Two', 'Rider', NULL, 1, NULL, 0)`);
  // A completed activity whose FIT lives in its journal and its export file.
  const done = activity(10, 'Done', { fit });
  db.prepare('INSERT INTO activity (id, player_id, name) VALUES (10, 1, ?)').run('Done');
  db.prepare('INSERT INTO activity_completion VALUES (10, 1, ?, NULL, 1)').run(toBinary(ActivitySchema, done));
  // A legacy activity from before the journal: only its export file has the FIT bytes.
  db.prepare("INSERT INTO activity (id, player_id, name, end_date) VALUES (11, 1, 'Old', '2026-01-01')").run();
  db.exec(`INSERT INTO activity_upload VALUES (10, 'runalyze', 'sending'), (10, 'intervals', 'pending'),
    (10, 'garmin', 'failed'), (10, 'strava', 'sent'), (10, 'zwift', 'cancelled')`);
  db.close();

  const settings = SettingsStore.legacy(storage);
  settings.save(1, { 'ghosts.enabled': true });
  settings.saveWorld('blob:1', { riders: 4 });
  settings.close();

  writeFileSync(resolve(storage, StorageFile.CredentialsKey), key);
  write(storage, '1/profile.bin', profile);
  write(storage, '1/streaks.bin', toBinary(StreaksSchema, previous));
  write(storage, '1/strava_token.txt', '1\nsecret\naccess\nrefresh\n9\n');
  write(storage, '1/runalyze_token.txt', 'runalyze');
  write(storage, '1/zwift_credentials.bin', crypto.encryptCredentials(key, ['user', 'pass']));
  write(storage, '1/encryption_key.bin', crypto.randomBytes(16));
  write(storage, '1/garth/oauth1_token.json', '{"oauth_token":"t","oauth_token_secret":"s"}');
  write(storage, '1/last_activity.bin', 'obsolete');
  write(storage, '1/bookmarks/6/0/Home.bin', toBinary(PlayerStateSchema, create(PlayerStateSchema, { x: 5 })));
  write(storage, '1/fit/10 - ride.fit', fit);
  write(storage, '1/fit/11 - old.fit', fit);
  write(storage, '1/medias/1.mp4', 'video');
  write(storage, '99/profile.bin', 'orphan');

  return {
    storage,
    open: () => {
      const database = openDatabase(storage);
      databases.push(database);

      return database;
    },
  };
}

function journal(storage: string, streak: Uint8Array | null) {
  const db = openLegacy(storage);
  const pending = activity(20, 'Journal name', { fit });
  db.prepare("INSERT INTO activity (id, player_id, name) VALUES (20, 1, 'Draft name')").run();
  db.prepare('INSERT INTO activity_completion VALUES (20, 1, ?, ?, 0)').run(toBinary(ActivitySchema, pending), streak);
  db.close();

  return pending;
}

function openLegacy(storage: string) {
  return new DatabaseSync(resolve(storage, 'zluggish.db'));
}

const blob = (value: SQLOutputValue | undefined) =>
  Buffer.from(Schema.decodeUnknownSync(Schema.instanceOf(Uint8Array))(value));

await test('the storage merge imports every legacy store once and keeps the legacy files', (t) => {
  const { storage, open } = legacy(t);
  const db = open();
  const documents = new RiderDocuments(db, storage);

  assert.equal(db.prepare('SELECT version FROM version').get()?.version, 11);
  assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
  assert.deepEqual(new SettingsStore(db).read(1), { 'ghosts.enabled': true });
  assert.deepEqual(new SettingsStore(db).world('blob:1'), { riders: 4 });
  assert.equal(fromBinary(PlayerProfileSchema, documents.get(1, 'profile.bin') ?? new Uint8Array()).firstName, 'One');
  assert.equal(documents.text(1, 'strava_token.txt'), '1\nsecret\naccess\nrefresh\n9\n');
  assert.equal(
    blob(db.prepare("SELECT data FROM rider_document WHERE name='strava_token.txt'").get()?.data).includes('access'),
    false,
    'imported secrets are encrypted',
  );
  assert.deepEqual(crypto.decryptCredentials(key, documents.get(1, 'zwift_credentials.bin') ?? new Uint8Array()), [
    'user',
    'pass',
  ]);
  assert.equal(db.prepare('SELECT name FROM bookmark WHERE player_id=1').get()?.name, 'Home');

  // Every document holds the exact file bytes, unknown fields and identifiers included.
  for (const name of imported) {
    assert.deepEqual(Buffer.from(documents.get(1, name) ?? []), readFileSync(resolve(storage, '1', name)), name);
  }

  assert.equal(
    fromBinary(PlayerProfileSchema, documents.get(1, 'profile.bin') ?? new Uint8Array()).id,
    9_007_199_254_740_993n,
  );
  assert.deepEqual(
    {
      ...db
        .prepare(
          'SELECT pass_hash, auth_version, CAST(official_player_id AS TEXT) AS official FROM user WHERE player_id=1',
        )
        .get(),
    },
    { pass_hash: '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA', auth_version: 3, official: '9007199254740993' },
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM rider_document WHERE player_id=99').get()?.n, 0);

  // One canonical FIT copy: the column. Journal payloads hold none.
  assert.deepEqual(blob(db.prepare('SELECT fit FROM activity WHERE id=10').get()?.fit), fit);
  assert.deepEqual(blob(db.prepare('SELECT fit FROM activity WHERE id=11').get()?.fit), fit);

  const payload = fromBinary(
    ActivitySchema,
    blob(db.prepare('SELECT payload FROM activity_completion').get()?.payload),
  );

  assert.equal(payload.fit.length, 0);
  assert.equal(payload.name, 'Done');

  assert.deepEqual(
    db
      .prepare('SELECT provider, state FROM activity_upload ORDER BY provider')
      .all()
      .map((row) => [row.provider, row.state]),
    [
      ['garmin', 'failed'],
      ['intervals', 'pending'],
      ['runalyze', 'ambiguous'],
      ['strava', 'sent'],
      ['zwift', 'cancelled'],
    ],
  );
  assert.deepEqual(
    db
      .prepare("SELECT payload FROM job WHERE type='delivery'")
      .all()
      .map((row) => row.payload),
    ['{"activityId":10,"provider":"intervals"}'],
  );

  const manifest = Schema.decodeUnknownSync(
    Schema.Struct({
      state: Schema.String,
      backup: Schema.String,
      report: Schema.Struct({ orphanFolders: Schema.Array(Schema.String) }),
    }),
  )(JSON.parse(readFileSync(resolve(storage, StorageFile.Manifest), 'utf8')));

  assert.equal(manifest.state, 'published');
  assert.deepEqual(manifest.report.orphanFolders, ['99']);

  const backup = Schema.decodeUnknownSync(Schema.Struct({ checksums: Schema.Record(Schema.String, Schema.String) }))(
    JSON.parse(readArchivedFile(manifest.backup, 'backup-manifest.json')),
  );

  for (const name of ['zluggish.db', 'settings.db', '1/streaks.bin', '1/medias/1.mp4', 'credentials-key.bin']) {
    assert.ok(backup.checksums[join(...name.split('/'))], `backup holds ${name}`);
  }

  for (const name of ['settings.db', '1/profile.bin', '1/strava_token.txt', '1/bookmarks/6/0/Home.bin']) {
    assert.ok(existsSync(resolve(storage, name)), `legacy ${name} is kept`);
  }
});

await test('legacy credentials written with another key are reported and left in place', (t) => {
  const { storage, open } = legacy(t);
  let credentials: Uint8Array;

  // CFB8 has no authentication, so a wrong key can occasionally produce valid UTF-8 with two lines.
  // Choose a key that this decoder definitely rejects so the migration case is deterministic.
  while (true) {
    credentials = crypto.encryptCredentials(crypto.randomBytes(32), ['user', 'pass']);

    try {
      crypto.decryptCredentials(key, credentials);
    } catch {
      break;
    }
  }

  write(storage, '2/garmin_credentials.bin', credentials);
  const db = open();

  assert.equal(new RiderDocuments(db, storage).has(2, 'garmin_credentials.bin'), false);
  assert.equal(new RiderDocuments(db, storage).has(1, 'zwift_credentials.bin'), true);

  const manifest = Schema.decodeUnknownSync(
    Schema.Struct({ report: Schema.Struct({ invalidOptional: Schema.Array(Schema.String) }) }),
  )(JSON.parse(readFileSync(resolve(storage, StorageFile.Manifest), 'utf8')));

  assert.deepEqual(manifest.report.invalidOptional, ['2/garmin_credentials.bin']);
  db.close();
  assert.ok(
    legacyPlan(storage).kept.some(({ path }) => path === resolve(storage, '2/garmin_credentials.bin')),
    'the legacy file is kept',
  );
});

await test('a legacy backup preserves the storage tree and the original schema', (t) => {
  const { storage, open } = legacy(t);
  const db = openLegacy(storage);
  db.exec('DROP TABLE activity_completion; DROP TABLE activity_upload;');
  db.close();
  write(storage, 'custom/local.cfg', 'original setting');

  open().close();

  const manifest = Schema.decodeUnknownSync(Schema.Struct({ backup: Schema.String }))(
    JSON.parse(readFileSync(resolve(storage, StorageFile.Manifest), 'utf8')),
  );

  assert.equal(resolve(manifest.backup, '..'), resolve(storage, 'backups'));
  assert.equal(existsSync(resolve(storage, '..', 'backups')), false);
  write(storage, 'custom/local.cfg', 'changed setting');
  assert.match(manifest.backup, /\.tar\.gz$/);
  assert.equal(readArchivedFile(manifest.backup, 'custom/local.cfg'), 'original setting');

  withBackupDirectory(manifest.backup, (directory) => {
    const saved = new DatabaseSync(resolve(directory, StorageFile.Database), { readOnly: true });

    try {
      assert.equal(saved.prepare('SELECT version FROM version').get()?.version, 5);
      assert.equal(saved.prepare("SELECT name FROM sqlite_master WHERE name='activity_completion'").get(), undefined);
    } finally {
      saved.close();
    }
  });
});

await test('a repeated start does not migrate again', (t) => {
  const { storage, open } = legacy(t);
  open().close();
  const before = readdirSync(resolve(storage, 'backups'));
  const db = open();
  assert.deepEqual(readdirSync(resolve(storage, 'backups')), before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM rider_document').get()?.n, 6);
});

const snapshot = toBinary(StreaksSchema, StreakService.advancedStreak(previous, activity(20, 'Journal name', { fit })));

for (const [point, prepare] of [
  ['before the streak file was written', () => {}],
  ['after the streak file was written', (storage: string) => write(storage, '1/streaks.bin', snapshot)],
  [
    'with no streak file and the profile fallback',
    (storage: string) => {
      rmSync(resolve(storage, '1/streaks.bin'));
    },
  ],
] as const) {
  await test(`a stopped completion applies progression once: ${point}`, (t) => {
    const { storage, open } = legacy(t);

    const expected =
      point === 'with no streak file and the profile fallback'
        ? toBinary(StreaksSchema, StreakService.advancedStreak(StreakService.fromProfile(null), activity(20, 'x')))
        : snapshot;

    journal(storage, expected);
    prepare(storage);
    const db = open();
    const documents = new RiderDocuments(db, storage);
    assert.deepEqual(Buffer.from(documents.get(1, 'streaks.bin') ?? []), Buffer.from(expected));
    assert.equal(db.prepare('SELECT done FROM activity_completion WHERE activity_id=20').get()?.done, 1);
    assert.equal(db.prepare('SELECT name FROM activity WHERE id=20').get()?.name, 'Journal name');
    assert.deepEqual(
      db
        .prepare('SELECT type FROM job WHERE payload=\'{"activityId":20}\' ORDER BY type')
        .all()
        .map((row) => row.type),
      ['completion_deliveries', 'fit_export', 'power_curve'],
    );
  });
}

await test('a stopped completion whose journal disagrees with the rider files stops the migration', (t) => {
  const { storage, open } = legacy(t);
  journal(storage, snapshot);
  write(storage, '1/streaks.bin', toBinary(StreaksSchema, create(StreaksSchema, { curStreak: 40, maxStreak: 40 })));
  assert.throws(() => open(), /disagrees/);
  // The source stays unchanged and usable by the previous release.
  const db = openLegacy(storage);
  assert.equal(db.prepare('SELECT version FROM version').get()?.version, 5);
  db.close();
});

await test('required FIT copies that differ stop the migration', (t) => {
  const { storage, open } = legacy(t);
  const db = openLegacy(storage);
  db.prepare('UPDATE activity SET fit=? WHERE id=10').run(new Uint8Array([1, 2, 3]));
  db.close();
  assert.throws(() => open(), /two different FIT payloads/);
});

await test('committed data in a legacy WAL file is migrated', (t) => {
  const { storage, open } = legacy(t);
  const path = resolve(storage, 'zluggish.db');
  const db = openLegacy(storage);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE user SET first_name='Walled' WHERE player_id=2",
  );
  copyFileSync(path, `${path}.copy`);
  copyFileSync(`${path}-wal`, `${path}-wal.copy`);
  db.close();
  copyFileSync(`${path}.copy`, path);
  copyFileSync(`${path}-wal.copy`, `${path}-wal`);
  rmSync(`${path}.copy`);
  rmSync(`${path}-wal.copy`);
  const migrated = open();
  assert.equal(migrated.prepare('SELECT first_name FROM user WHERE player_id=2').get()?.first_name, 'Walled');
});

for (const step of Object.values(MigrationStep)) {
  await test(`a stop after the ${step} step restarts into one complete database`, (t) => {
    const { storage, open } = legacy(t);

    assert.throws(
      () =>
        migrateStorage(storage, (reached) => {
          if (reached === step) {
            throw new Error('stopped');
          }
        }),
      /stopped/,
    );

    const db = open();
    assert.equal(db.prepare('SELECT version FROM version').get()?.version, 11);
    assert.equal(db.prepare('SELECT count(*) AS n FROM rider_document').get()?.n, 6);
    assert.equal(db.prepare("SELECT count(*) AS n FROM job WHERE type='delivery'").get()?.n, 1);
    assert.equal(existsSync(resolve(storage, StorageFile.Temporary)), false);
    assert.ok(existsSync(resolve(storage, '1/profile.bin')));
  });
}

await test('an interrupted publication with an unknown database stops with a recovery instruction', (t) => {
  const { storage, open } = legacy(t);
  assert.throws(
    () =>
      migrateStorage(storage, (reached) => {
        if (reached === 'publishing') {
          throw new Error('stopped');
        }
      }),
    /stopped/,
  );
  writeFileSync(resolve(storage, 'zluggish.db'), 'damaged');
  assert.throws(() => open(), /matches neither the source nor the migrated copy.*Restore/);
});

for (const [problem, damage] of [
  ['an unreadable profile', (storage: string) => write(storage, '1/profile.bin', new Uint8Array([0xff, 0xff]))],
  [
    'an unreadable completion journal',
    (storage: string) => {
      const db = openLegacy(storage);
      db.prepare('UPDATE activity_completion SET payload=? WHERE activity_id=10').run(new Uint8Array([0xff, 0xff]));
      db.close();
    },
  ],
] as const) {
  await test(`${problem} stops the migration and keeps the source`, (t) => {
    const { storage, open } = legacy(t);
    damage(storage);
    const before = readFileSync(resolve(storage, 'zluggish.db'));
    assert.throws(() => open());
    assert.deepEqual(readFileSync(resolve(storage, 'zluggish.db')), before);
    assert.equal(existsSync(resolve(storage, StorageFile.Temporary)), false);
  });
}

await test('a legacy cleanup preview removes nothing and lists only imported, backed-up files', (t) => {
  const { storage, open } = legacy(t);
  open().close();
  const plan = legacyPlan(storage);
  const removable = plan.removable.map((file) => relative(storage, file.path)).toSorted();

  assert.deepEqual(
    removable,
    [
      ...imported.map((name) => join('1', ...name.split('/'))),
      join('1', 'bookmarks', '6', '0', 'Home.bin'),
      join('1', 'last_activity.bin'),
      'settings.db',
    ].toSorted(),
  );
  assert.deepEqual(
    plan.kept.map((file) => [relative(storage, file.path), file.reason]),
    [
      [join('1', 'encryption_key.bin'), 'not in the database'],
      ['99', 'no account for this rider folder'],
    ],
  );

  for (const file of plan.removable) {
    assert.ok(existsSync(file.path));
  }
});

await test('a legacy cleanup removes the imported files and keeps media, exports and keys', (t) => {
  const { storage, open } = legacy(t);
  open().close();
  removeLegacy(storage, legacyPlan(storage));

  for (const name of [...imported, 'last_activity.bin', 'bookmarks', 'garth']) {
    assert.equal(existsSync(resolve(storage, '1', name)), false, name);
  }

  assert.equal(existsSync(resolve(storage, 'settings.db')), false);

  for (const name of ['99/profile.bin', StorageFile.CredentialsKey]) {
    assert.ok(existsSync(resolve(storage, name)), name);
  }

  // Version 11 moved the exports into activity folders; the video has no row and is kept aside.
  assert.deepEqual(readdirSync(resolve(storage, '1/activities')).toSorted(), [
    '1970-01-01T000000Z_10',
    '2026-01-01T000000Z_11',
    'orphaned',
  ]);
  assert.ok(existsSync(resolve(storage, '1/activities/1970-01-01T000000Z_10/activity.fit')));
  assert.ok(existsSync(resolve(storage, '1/activities/2026-01-01T000000Z_11/activity.fit')));
  assert.ok(existsSync(resolve(storage, '1/activities/orphaned/videos/1.mp4')));

  const db = open();
  assert.equal(new RiderDocuments(db, storage).text(1, 'runalyze_token.txt'), 'runalyze');
  assert.deepEqual(new SettingsStore(db).read(1), { 'ghosts.enabled': true });
  assert.equal(legacyPlan(storage).removable.length, 0);
});

await test('a legacy file that changed after the migration is kept', (t) => {
  const { storage, open } = legacy(t);
  open().close();
  write(storage, '1/runalyze_token.txt', 'edited later');
  const plan = legacyPlan(storage);
  assert.deepEqual(
    plan.kept.find((file) => file.path === resolve(storage, '1/runalyze_token.txt'))?.reason,
    'not identical to the migration backup',
  );
  assert.equal(
    plan.removable.some((file) => file.path === resolve(storage, '1/runalyze_token.txt')),
    false,
  );
});

await test('a legacy cleanup needs a published migration and its backup', (t) => {
  const { storage, open } = legacy(t);
  assert.throws(() => legacyPlan(storage), /No published storage migration/);
  open().close();

  const backup = Schema.decodeUnknownSync(Schema.Struct({ backup: Schema.String }))(
    JSON.parse(readFileSync(resolve(storage, StorageFile.Manifest), 'utf8')),
  ).backup;

  rmSync(backup, { recursive: true });
  assert.throws(() => legacyPlan(storage), /backup .* is missing/);
});

await test('a failed initial archive leaves existing legacy storage byte-for-byte unchanged', (t) => {
  const { storage, open } = legacy(t);

  const snapshot = () =>
    new Map(
      readdirSync(storage, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const path = resolve(entry.parentPath, entry.name);

          return [relative(storage, path), readFileSync(path)];
        }),
    );

  writeFileSync(resolve(storage, 'backups'), 'blocks backup directory');
  const before = snapshot();

  assert.throws(() => open(), /backup/i);
  assert.deepEqual(snapshot(), before);
  assert.equal(existsSync(resolve(storage, StorageFile.Manifest)), false);
  assert.equal(existsSync(resolve(storage, StorageFile.Temporary)), false);
});

await test('a failed initial archive creates no database when only legacy settings exist', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'zluggish-legacy-settings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = resolve(root, 'storage');
  mkdirSync(storage);
  const settings = SettingsStore.legacy(storage);
  settings.save(12, { 'ghosts.enabled': true });
  settings.close();
  const settingsPath = resolve(storage, StorageFile.Settings);
  const before = readFileSync(settingsPath);
  writeFileSync(resolve(storage, 'backups'), 'blocks backup directory');

  assert.throws(() => openDatabase(storage), /backup/i);
  assert.deepEqual(readdirSync(storage).toSorted(), ['backups', StorageFile.Settings].toSorted());
  assert.deepEqual(readFileSync(settingsPath), before);
});

await test('an unreadable legacy database leaves no partial archive or migration state', (t) => {
  const { storage, open } = legacy(t);
  const settings = resolve(storage, StorageFile.Settings);
  const database = resolve(storage, StorageFile.Database);
  const original = readFileSync(database);
  const invalid = 'unreadable legacy settings database';
  writeFileSync(settings, invalid);

  assert.throws(() => open(), /not a database/i);
  assert.deepEqual(readFileSync(database), original);
  assert.equal(readFileSync(settings, 'utf8'), invalid);
  assert.deepEqual(readdirSync(resolve(storage, 'backups')), []);
  assert.equal(existsSync(resolve(storage, StorageFile.Manifest)), false);
  assert.equal(existsSync(resolve(storage, StorageFile.Temporary)), false);
});
