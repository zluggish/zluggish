# Database access

Repositories build queries with the typed SQLite `query` instance in `query.ts`
and execute them through `SqliteExecutor`. The executor compiles Kysely queries
and runs them on the existing `node:sqlite` connection synchronously. Use its
`get`, `all`, and `run` methods; do not call Kysely's asynchronous `execute`
methods on the query builder.

```ts
const executor = new SqliteExecutor(db);
const account = executor.get(query.selectFrom('user').select('first_name').where('player_id', '=', id));
```

Services coordinate workflows, including repository calls and filesystem
persistence. They are Effect services (see `../layers.ts`); repositories stay
synchronous classes that services reach through `AccountsService.repositories`.
Repositories receive the shared SQLite connection and can compose other
persistence repositories. Keep schema initialization in `open.ts` and
`ddl.ts`, and legacy database upgrades in `../migrations`.

Transactions must use the same connection for all participating repositories.
Keep `BEGIN IMMEDIATE` through `COMMIT` or `ROLLBACK` synchronous: do asynchronous
password hashing, provider requests, and similar work before acquiring the
transaction. Awaiting with a transaction open could let another request use it.

Use `all(selection, true)` or `get(selection, true)` when reading protobuf int64
fields. This preserves integer values as bigint while SQLite REAL fields stay
numbers. Use `integer(routeParameter)` to bind string identifiers without
converting them through Number. Write results return safe integers as numbers
and larger row IDs as bigint.

`schema.ts` describes the current schema for Kysely. Keep it aligned with DDL
changes. Raw SQL remains appropriate for schema inspection and legacy migrations,
which may operate before the current schema exists. SQLite-specific expressions
in ordinary queries use Kysely's parameterized `sql` template.

## Transactions, WAL and checkpoints

Use `immediate(db, operation)` from `transaction.ts` for a write transaction, or
`atomic(db, operation)` to join a caller's transaction. Both record the duration in
the metrics summary.

In an Effect, use `transaction(db)(effect)`. It runs the effect synchronously between
`BEGIN IMMEDIATE` and `COMMIT`, and joins a transaction that is already open. A failure
rolls back. An effect that does asynchronous work cannot run in a transaction: it
rolls back and fails.

Connections use WAL with `synchronous=FULL` and foreign keys (`configureConnection`).
While the runtime runs, the checkpoint worker (`checkpoint.repository.ts`) owns WAL
checkpoints: it uses its own connection and `PRAGMA wal_checkpoint(PASSIVE)`, and the
main connection does not auto-checkpoint. At shutdown the main connection truncates
the WAL once.

## Migrations

`open.ts` creates version 6 directly. Version 4 upgrades to 5 in place. Version 5,
or a `settings.db` from an offline config migration, runs the storage merge in
`../migrations/storage.ts`: backup, import into a temporary database, validation,
closed-database publication with a durable manifest, and a startup check of that
manifest. Later schema changes go in the `migrations` list in `open.ts`; each runs in
one transaction at startup. A migration marked `backup` backs up an existing store
first. Version 11 (`../migrations/activity-folders.ts`) rebuilds `activity` with
`AUTOINCREMENT`, so ids are never reused, and moves activity files into one folder per
activity (`../activity-storage.ts`). Its file moves are repeatable, so a stop before the
commit only runs it again.

## Durable jobs

`jobs.repository.ts` holds the job table. Insert a job in the same transaction as the
change that requires it. A handler commits its result with `job.commit(result)`, which
checks the claim token and the lease in the same transaction. Payloads hold
identifiers only.

## Durability barrier

While the runtime runs, the main connection uses `synchronous=NORMAL`: commits write
the WAL without a flush on the main thread. `DurabilityRepository.flush()` flushes the
WAL on the libuv thread pool. The HTTP middleware waits for it before the response of
any request that changed the database, and a delivery waits for it after it commits
`sending`. Work that acknowledges a save outside HTTP must also wait for `flush()`.
Relay nonce reservations temporarily use `synchronous=FULL` and commit outside any
transaction before a synchronous socket send. This prevents power loss from rolling
back a nonce that has already been used. Offline commands keep `synchronous=FULL`.
