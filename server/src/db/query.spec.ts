import { createSchemaSQL, completionSchemaSQL } from '#src/db/ddl';
import { query, SqliteExecutor } from '#src/db/query';
import { integer } from '#src/db/values';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

function fixture(t: import('node:test').TestContext) {
  const db = new DatabaseSync(':memory:');
  db.exec(createSchemaSQL);
  db.exec(completionSchemaSQL);
  t.after(() => db.close());

  return { db, executor: new SqliteExecutor(db) };
}

await test('compiled queries preserve int64 identifiers and real values', (t) => {
  const { executor } = fixture(t);
  const id = 9_007_199_254_740_993n;
  const inserted = executor.run(query.insertInto('activity').values({ id, player_id: 1, distanceInMeters: 42.25 }));
  assert.equal(inserted.lastInsertRowid, id);

  const selection = query
    .selectFrom('activity')
    .select(['id', 'distanceInMeters'])
    .where('id', '=', integer(String(id)));

  assert.deepEqual({ ...executor.get(selection, true) }, { id, distanceInMeters: 42.25 });
  assert.throws(() => executor.get(selection), /too large|safe integer/i);
});

await test('compiled operations participate in the existing connection transaction', (t) => {
  const { db, executor } = fixture(t);
  db.exec('BEGIN IMMEDIATE');
  executor.run(query.insertInto('private_event').values({ json: '{}' }));
  assert.equal(executor.all(query.selectFrom('private_event').selectAll()).length, 1);
  db.exec('ROLLBACK');
  assert.equal(executor.all(query.selectFrom('private_event').selectAll()).length, 0);
});

await test('query values remain bound parameters and insert results preserve row IDs', (t) => {
  const { executor } = fixture(t);
  const payload = `'); DROP TABLE private_event; --`;
  const inserted = executor.run(query.insertInto('private_event').values({ json: payload }));
  const row = executor.get(query.selectFrom('private_event').selectAll().where('id', '=', inserted.lastInsertRowid));
  assert.equal(row?.json, payload);
  assert.equal(
    executor.get(query.selectFrom('private_event').select('id').where('id', '=', integer('1 OR 1=1'))),
    undefined,
  );
});
