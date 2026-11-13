import type { Database } from '#src/db/schema';
import { DummyDriver, Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';
import type { Compilable } from 'kysely';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

// Build typed SQLite queries without introducing asynchronous execution into
// synchronous transactions shared by the server's repositories.
export const query = new Kysely<Database>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

type BigIntRow<Row> = {
  [Key in keyof Row]: number extends Row[Key] ? Row[Key] | bigint : Row[Key];
};

type NumberRow<Row> = {
  [Key in keyof Row]: bigint extends Row[Key] ? Exclude<Row[Key], bigint> | number : Row[Key];
};

function safeNumber(value: number | bigint) {
  return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : value;
}

export class SqliteExecutor {
  constructor(private readonly db: DatabaseSync) {}

  private prepare<Row>(builder: Compilable<Row>, bigints = false) {
    const compiled = builder.compile();
    const statement = this.db.prepare(compiled.sql);
    statement.setReadBigInts(bigints);

    // SAFETY: Parameters come from typed SQLite query values or parameterized
    // sql expressions; node:sqlite validates their runtime representation.
    return { statement, parameters: compiled.parameters as SQLInputValue[] };
  }

  all<Row>(builder: Compilable<Row>): NumberRow<Row>[];
  all<Row>(builder: Compilable<Row>, bigints: true): BigIntRow<Row>[];
  all<Row>(builder: Compilable<Row>, bigints = false): NumberRow<Row>[] | BigIntRow<Row>[] {
    const { statement, parameters } = this.prepare(builder, bigints);

    // SAFETY: Kysely infers the selected columns; setReadBigInts determines
    // the integer representation and SQLite leaves REAL columns as numbers.
    return statement.all(...parameters) as NumberRow<Row>[] | BigIntRow<Row>[];
  }

  get<Row>(builder: Compilable<Row>): NumberRow<Row> | undefined;
  get<Row>(builder: Compilable<Row>, bigints: true): BigIntRow<Row> | undefined;
  get<Row>(builder: Compilable<Row>, bigints = false): NumberRow<Row> | BigIntRow<Row> | undefined {
    const { statement, parameters } = this.prepare(builder, bigints);

    // SAFETY: The compiled selection defines the row and setReadBigInts
    // controls integer decoding, just as in all().
    return statement.get(...parameters) as NumberRow<Row> | BigIntRow<Row> | undefined;
  }

  run(builder: Compilable) {
    const { statement, parameters } = this.prepare(builder, true);
    const result = statement.run(...parameters);

    // Always read write results as bigint: SQLite can commit an insert before
    // throwing while converting an oversized lastInsertRowid to Number.
    return { changes: safeNumber(result.changes), lastInsertRowid: safeNumber(result.lastInsertRowid) };
  }
}
