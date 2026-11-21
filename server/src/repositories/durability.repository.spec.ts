import { DurabilityRepository } from '#src/repositories/durability.repository';
import assert from 'node:assert/strict';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

function hasSync(value: unknown): value is { sync: () => Promise<void> } {
  return typeof value === 'object' && value !== null && 'sync' in value && typeof value.sync === 'function';
}

await test('queued flushes recover after a WAL sync failure and still cover later commits', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'durability-'));
  const path = join(directory, 'test.db');
  const db = new DatabaseSync(path);
  t.after(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE writes (value INTEGER)');
  const barrier = new DurabilityRepository(db, path);
  barrier.start();
  const handle = await open(`${path}-wal`, 'r+');
  const prototype = Reflect.getPrototypeOf(handle);
  assert.ok(hasSync(prototype));
  await handle.close();
  const gates = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
  const started = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
  let calls = 0;
  t.mock.method(prototype, 'sync', () => {
    const index = calls++;
    started[index]!.resolve();

    return gates[index]!.promise;
  });

  db.exec('INSERT INTO writes VALUES (1)');
  const first = barrier.flush();
  await started[0]!.promise;
  const queued = barrier.flush();
  assert.equal(barrier.flush(), queued);
  const failure = new Error('injected WAL sync failure');
  const rejected = [first, queued].map((promise) => assert.rejects(promise, (error) => error === failure));
  gates[0]!.reject(failure);
  await Promise.all(rejected);
  assert.equal(calls, 1, 'failed callers are not acknowledged by a retry');

  const retry = barrier.flush();
  await started[1]!.promise;
  db.exec('INSERT INTO writes VALUES (2)');
  const later = barrier.flush();
  assert.notEqual(later, queued, 'a failed queued flush is discarded');
  assert.equal(barrier.flush(), later, 'overlapping callers coalesce after failure');
  let durable = false;
  const acknowledged = later.then(() => {
    durable = true;
  });
  gates[1]!.resolve();
  await retry;
  await started[2]!.promise;
  assert.equal(durable, false, 'later commits wait for the queued sync');
  assert.equal(calls, 3);
  gates[2]!.resolve();
  await acknowledged;
  assert.equal(durable, true);
});
