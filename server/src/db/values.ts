import { sql } from 'kysely';

export type IntegerInput = number | bigint | string;

// Route parameters stay parameterized strings: SQLite applies integer affinity
// without a lossy conversion of 64-bit identifiers through JavaScript Number.
export function integer(value: IntegerInput) {
  return sql<number | bigint>`${value}`;
}
