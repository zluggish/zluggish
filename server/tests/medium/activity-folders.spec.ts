import {
  administratorSchemaSQL,
  completionSchemaSQL,
  createSchemaSQL,
  dropManagementAuditSQL,
  indexesSQL,
  storageSchemaSQL,
  webSessionSQL,
} from '#src/db/ddl';
import { openDatabase } from '#src/db/open';
import { migrateActivityFolders } from '#src/migrations/activity-folders';
import { activityDirectoryName } from '#src/activity-storage';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { test } from 'node:test';

const canonical = Buffer.from('canonical fit');
const other = Buffer.from('fit of an activity from an earlier database');

function write(path: string, data: string | Uint8Array = 'data') {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, data);
}

/** A version 10 store laid out like an install from before the activity folders: id-prefixed
FIT exports (one left over from an earlier activity with the same id), images and videos by
row id, a chart cache and the files of a deleted activity whose cleanup has not run.
*/
function version10(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'zluggish-folders-'));
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

  const db = new DatabaseSync(resolve(storage, 'zluggish.db'));
  db.exec(createSchemaSQL);
  db.exec(completionSchemaSQL);
  db.exec(storageSchemaSQL);
  db.exec(indexesSQL);
  db.exec(administratorSchemaSQL);
  db.exec(dropManagementAuditSQL);
  db.exec(webSessionSQL);
  db.exec('INSERT INTO version VALUES (10); INSERT INTO account_state VALUES (1, 1);');
  db.exec(`INSERT INTO user (player_id, username, first_name, last_name, pass_hash, auth_version)
    VALUES (2, 'two', 'Two', 'Rider', '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA', 3)`);
  db.prepare(
    "INSERT INTO activity (id, player_id, name, start_date, fit, fit_filename) VALUES (1, 2, 'Ride', '2026-08-18T10:58:49Z', ?, 'ride.fit')",
  ).run(canonical);
  db.prepare(
    "INSERT INTO activity (id, player_id, name, start_date, fit) VALUES (3, 2, 'Run', '2026-08-30T23:16:59.000+0000', ?)",
  ).run(canonical);
  db.exec(`INSERT INTO activity_image (id, player_id, activity_id, state) VALUES (41, 2, 1, 'ready');
    INSERT INTO activity_media (id, player_id, activity_id, content_type, state) VALUES (7, 2, 3, 'video/quicktime', 'ready');
    INSERT INTO activity_file (id, activity_id, full) VALUES (5, 1, 0);`);
  db.prepare("INSERT INTO job (type, payload, next_run_at, created_at) VALUES ('artifact_cleanup', ?, 0, 0)").run(
    JSON.stringify({ activityId: 2, playerId: 2, charts: '', images: '50', media: '8' }),
  );
  db.close();

  const rider = resolve(storage, '2');
  write(resolve(rider, 'fit', '1 - 2026-08-18-10-58-49.fit'), canonical);
  write(resolve(rider, 'fit', '1 - 2026-06-23-21-57-34.fit'), other);
  write(resolve(rider, 'fit', '2 - 2026-08-12-22-24-00.fit'), canonical);
  write(resolve(rider, 'fit', '3 - 2026-08-30-23-16-59.fit.abc.tmp'));
  write(resolve(rider, 'images', '41.jpg'), 'photo');
  write(resolve(rider, 'images', '50.jpg'), 'deleted photo');
  write(resolve(rider, 'images', '99.jpg'), 'unknown photo');
  write(resolve(rider, 'medias', '7.mov'), 'video');
  write(resolve(rider, 'medias', '8.mp4'), 'deleted video');
  write(resolve(storage, 'activities', '5'), '{}');

  return {
    storage,
    rider,
    open: () => {
      const database = openDatabase(storage);
      databases.push(database);

      return database;
    },
  };
}

function assertMigrated(storage: string, rider: string, db: DatabaseSync) {
  assert.equal(db.prepare('SELECT version FROM version').get()?.version, 11);

  const activities = resolve(rider, 'activities');
  assert.deepEqual(readdirSync(activities).toSorted(), ['2026-08-18T105849Z_1', '2026-08-30T231659Z_3', 'orphaned']);
  assert.deepEqual(readFileSync(resolve(activities, '2026-08-18T105849Z_1', 'activity.fit')), canonical);
  assert.equal(readFileSync(resolve(activities, '2026-08-18T105849Z_1', 'images', '41.jpg'), 'utf8'), 'photo');
  assert.equal(readFileSync(resolve(activities, '2026-08-30T231659Z_3', 'videos', '7.mov'), 'utf8'), 'video');
  assert.deepEqual(readFileSync(resolve(activities, 'orphaned', '1 - 2026-06-23-21-57-34.fit')), other);
  assert.equal(readFileSync(resolve(activities, 'orphaned', 'images', '99.jpg'), 'utf8'), 'unknown photo');
  assert.deepEqual(readdirSync(resolve(activities, 'orphaned')).toSorted(), ['1 - 2026-06-23-21-57-34.fit', 'images']);

  for (const legacy of ['fit', 'images', 'medias']) {
    assert.equal(existsSync(resolve(rider, legacy)), false, legacy);
  }
  assert.equal(existsSync(resolve(storage, 'activities')), false, 'the chart cache is dropped');

  assert.deepEqual(
    db
      .prepare('SELECT id, storage_dir FROM activity ORDER BY id')
      .all()
      .map((row) => [row.id, row.storage_dir]),
    [
      [1, '2026-08-18T105849Z_1'],
      [3, '2026-08-30T231659Z_3'],
    ],
  );
  assert.deepEqual(
    db
      .prepare("SELECT payload FROM job WHERE type='fit_export'")
      .all()
      .map((row) => row.payload),
    [JSON.stringify({ activityId: 3 })],
    'only the activity without a matching export gets a new one',
  );
}

await test('version 11 moves activity files into one folder per activity and keeps what it cannot match', (t) => {
  const { storage, rider, open } = version10(t);
  const db = open();

  assertMigrated(storage, rider, db);
  assert.ok(
    readdirSync(resolve(storage, 'backups')).some((name) => name.startsWith('storage-v11-')),
    'the store is backed up first',
  );
});

await test('version 11 never hands out an activity id again', (t) => {
  const { open } = version10(t);
  const db = open();

  db.exec('DELETE FROM activity WHERE id=3');
  const id = db.prepare("INSERT INTO activity (player_id, name) VALUES (2, 'New')").run().lastInsertRowid;

  assert.equal(id, 4);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND tbl_name='activity'").get()?.n,
    3,
    'the activity indexes are rebuilt',
  );
});

await test('version 11 repeats cleanly after a stop between its file moves and its commit', (t) => {
  const { storage, rider, open } = version10(t);
  const db = new DatabaseSync(resolve(storage, 'zluggish.db'));
  db.exec('BEGIN IMMEDIATE');
  migrateActivityFolders(db, storage);
  db.exec('ROLLBACK');
  db.close();

  assertMigrated(storage, rider, open());
});

await test('folder names sort by start time and fall back to the next date', () => {
  assert.equal(activityDirectoryName(33, ['2026-11-22T22:37:16.000+0000']), '2026-11-22T223716Z_33');
  assert.equal(activityDirectoryName(5, [null, 'not a date', '2026-01-01T00:00:00Z']), '2026-01-01T000000Z_5');
  assert.equal(activityDirectoryName(6, [null], 0), '1970-01-01T000000Z_6');
  assert.match(activityDirectoryName(1, []), /^\d{4}-\d{2}-\d{2}T\d{6}Z_1$/, 'without dates it uses the clock');
});
