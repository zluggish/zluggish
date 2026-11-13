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
persistence. Repositories receive the shared SQLite connection and can compose
other persistence repositories. Keep schema initialization in `open.ts` and
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
