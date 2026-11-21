import { WorkoutPublication } from '#src/repositories/workout-publication.repository';
import { AssetFiles } from '#src/repositories/files.repository';
import { configureConnection } from '#src/db/open';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

// Real subprocess exits bypass catch/finally and leave SQLite to recover its WAL.
for (const boundary of [1, 2, 3, 4, 5, 6, 7]) {
  await test(`publication recovers process exit at boundary ${boundary}`, (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'workout-crash-'));
    const db = new DatabaseSync(resolve(root, 'db'));
    t.after(() => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const child = spawnSync(
      process.execPath,
      [
        '--conditions=development',
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { WorkoutPublication } from ${JSON.stringify(new URL('workout-publication.repository.ts', import.meta.url).href)};
      import { AssetFiles } from ${JSON.stringify(new URL('files.repository.ts', import.meta.url).href)};
      import { DatabaseSync } from 'node:sqlite';
      import { resolve } from 'node:path';
      const root = ${JSON.stringify(root)};
      const db = new DatabaseSync(resolve(root, 'db'));
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE listing (name TEXT)');
      const files = new AssetFiles();
      for (const name of ['existing.zwo', 'intervals_icu_workout.json', 'active_workout_provider.txt']) {
        files.writeDurable(resolve(root, name), 'old');
      }
      const publication = new WorkoutPublication(db, root, files);
      let writes = 0;
      const write = files.writeDurable.bind(files);
      files.writeDurable = (...args) => {
        ++writes;
        if (${boundary} === 6 && writes === 6) process.exit(73);
        write(...args);
        if (writes === ${boundary} || (${boundary} === 7 && writes === 6)) process.exit(73);
      };
      publication.publish(new Map([
        [resolve(root, 'existing.zwo'), 'new'],
        [resolve(root, 'new.zwo'), 'new'],
        [resolve(root, 'intervals_icu_workout.json'), 'new'],
        [resolve(root, 'active_workout_provider.txt'), 'new'],
      ]), () => db.exec("INSERT INTO listing VALUES ('new')"));
    `,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(child.status, 73, child.stderr);
    configureConnection(db);
    new WorkoutPublication(db, root);
    const committed = boundary >= 6;
    assert.equal(readFileSync(resolve(root, 'existing.zwo'), 'utf8'), committed ? 'new' : 'old');
    assert.equal(existsSync(resolve(root, 'new.zwo')), committed);
    for (const name of ['intervals_icu_workout.json', 'active_workout_provider.txt']) {
      assert.equal(readFileSync(resolve(root, name), 'utf8'), committed ? 'new' : 'old');
    }
    assert.equal(db.prepare('SELECT * FROM listing').all().length, committed ? 1 : 0);
    new WorkoutPublication(db, root); // repeated startup is harmless
    assert.equal(readFileSync(resolve(root, 'workout-publication.json'), 'utf8'), 'null');
  });
}

await test('failed restore keeps the journal and retry completes recovery', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'workout-fault-'));
  const db = new DatabaseSync(resolve(root, 'db'));
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const files = new AssetFiles();
  const publication = new WorkoutPublication(db, root, files);
  const path = resolve(root, 'existing.zwo');
  files.writeDurable(path, 'old');
  const original = files.writeDurable.bind(files);
  let fail = false;
  t.mock.method(files, 'writeDurable', (...args: Parameters<AssetFiles['writeDurable']>) => {
    if (fail && args[0] === path) {
      throw new Error('disk unavailable');
    }
    original(...args);
  });
  assert.throws(
    () =>
      publication.publish(
        new Map([
          [path, 'new'],
          [resolve(root, 'new.zwo'), 'new'],
        ]),
        () => {
          fail = true;
          throw new Error('listing failed');
        },
      ),
    /disk unavailable/,
  );
  assert.notEqual(readFileSync(resolve(root, 'workout-publication.json'), 'utf8'), 'null');
  fail = false;
  publication.recover();
  assert.equal(readFileSync(path, 'utf8'), 'old');
  assert.equal(existsSync(resolve(root, 'new.zwo')), false);
});

for (const failure of ['file', 'listing', 'commit']) {
  await test(`publication rolls back ${failure} failure`, (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'workout-rollback-'));
    const db = new DatabaseSync(resolve(root, 'db'));
    t.after(() => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    db.exec('CREATE TABLE listing (name TEXT)');
    const files = new AssetFiles();
    const publication = new WorkoutPublication(db, root, files);
    const path = resolve(root, 'existing.zwo');
    files.writeDurable(path, 'old');
    const write = files.writeDurable.bind(files);
    let injected = false;
    t.mock.method(files, 'writeDurable', (...args: Parameters<AssetFiles['writeDurable']>) => {
      write(...args);
      if (failure !== 'file' || args[0] !== path || injected) {
        return;
      }
      injected = true;
      throw new Error('injected file failure after rename');
    });
    const exec = db.exec.bind(db);
    t.mock.method(db, 'exec', (sql: string) => {
      if (failure === 'commit' && sql === 'COMMIT') {
        throw new Error('injected commit failure');
      }
      return exec(sql);
    });
    assert.throws(
      () =>
        publication.publish(
          new Map([
            [path, 'new'],
            [resolve(root, 'new.zwo'), 'new'],
          ]),
          () => {
            db.exec("INSERT INTO listing VALUES ('new')");
            if (failure === 'listing') {
              throw new Error('injected listing failure');
            }
          },
        ),
      /injected/,
    );
    assert.equal(readFileSync(path, 'utf8'), 'old');
    assert.equal(existsSync(resolve(root, 'new.zwo')), false);
    assert.deepEqual(db.prepare('SELECT * FROM listing').all(), []);
    assert.equal(readFileSync(resolve(root, 'workout-publication.json'), 'utf8'), 'null');
  });
}
