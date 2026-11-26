import { t } from '#src/i18n/index';
import type { ProtobufTable } from '#src/enum';
import { query, SqliteExecutor } from '#src/db/query';
import type { DescMessage } from '@bufbuild/protobuf';
import { clearField, clone, fromJsonString, toJsonString } from '@bufbuild/protobuf';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { Schema } from 'effect';

const isScalar = Schema.is(Schema.Union([Schema.String, Schema.Finite, Schema.Null]));

export type ProtobufMessage<Schema extends DescMessage> = ReturnType<typeof fromJsonString<Schema>>;

export type Table = ProtobufTable;

export class ProtobufRows {
  private readonly executor: SqliteExecutor;

  constructor(readonly db: DatabaseSync) {
    this.executor = new SqliteExecutor(db);
  }

  values<Schema extends DescMessage>(
    table: Table,
    schema: Schema,
    message: ProtobufMessage<Schema>,
    exclude: Array<string> = [],
  ) {
    // Clear excluded fields before serialization: a FIT payload would otherwise be
    // encoded to base64 JSON and parsed again on the main thread.
    const included = clone(schema, message);

    for (const field of schema.fields) {
      if (exclude.includes(field.name)) {
        clearField(included, field);
      }
    }

    const json = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
      JSON.parse(
        toJsonString(schema, included, {
          useProtoFieldName: true,
          enumAsInteger: true,
        }),
      ),
    );

    const columns = new Set(
      this.db
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((row) => row.name),
    );

    const values = new Map<string, SQLInputValue>();

    for (const field of schema.fields) {
      if (!columns.has(field.name) || exclude.includes(field.name) || !(field.name in json)) {
        continue;
      }
      const value = json[field.name];

      if (value === undefined) {
        continue;
      }

      if (field.fieldKind === 'scalar' && [3, 4, 6, 16, 18].includes(field.scalar)) {
        values.set(
          field.name,
          BigInt.asIntN(64, BigInt(Schema.decodeUnknownSync(Schema.Union([Schema.String, Schema.Finite]))(value))),
        );
      } else if (field.fieldKind === 'scalar' && field.scalar === 8) {
        values.set(field.name, value ? 1 : 0);
      } else if (field.fieldKind === 'scalar' && field.scalar === 12) {
        values.set(field.name, Buffer.from(Schema.decodeUnknownSync(Schema.String)(value), 'base64'));
      } else {
        values.set(field.name, isScalar(value) ? value : JSON.stringify(value));
      }
    }

    return values;
  }

  insert<Schema extends DescMessage>(
    table: Table,
    schema: Schema,
    message: ProtobufMessage<Schema>,
    exclude: Array<string> = [],
  ) {
    const values = this.values(table, schema, message, ['id', ...exclude]);
    const keys = values.keys().toArray();

    if (keys.length === 0) {
      throw new Error(t('empty_database_record'));
    }

    return this.executor.run(query.insertInto(table).values(Object.fromEntries(values))).lastInsertRowid;
  }

  update<Schema extends DescMessage>(
    table: Table,
    id: bigint,
    schema: Schema,
    message: ProtobufMessage<Schema>,
    exclude: Array<string> = [],
  ) {
    const values = this.values(table, schema, message, ['id', ...exclude]);

    if (values.size > 0) {
      this.executor.run(query.updateTable(table).set(Object.fromEntries(values)).where('id', '=', id));
    }
  }

  select<Schema extends DescMessage>(table: Table, schema: Schema, playerId: bigint): Array<ProtobufMessage<Schema>> {
    return this.executor
      .all(query.selectFrom(table).selectAll().where('player_id', '=', playerId).orderBy('id'), true)
      .map((row) => this.decode(schema, row));
  }

  decode<Schema extends DescMessage>(
    schema: Schema,
    row: Record<string, string | number | bigint | Uint8Array | null>,
  ): ProtobufMessage<Schema> {
    const json: Record<string, typeof Schema.Json.Type> = {};

    for (const field of schema.fields) {
      const value = row[field.name];

      if (value === null || value === undefined || field.name === 'fit') {
        continue;
      }

      if (field.fieldKind === 'scalar' && [3, 4, 6, 16, 18].includes(field.scalar)) {
        json[field.name] = String(
          field.scalar === 4 || field.scalar === 6
            ? BigInt.asUintN(64, BigInt(Schema.decodeUnknownSync(Schema.Union([Schema.Finite, Schema.BigInt]))(value)))
            : value,
        );
      } else if (field.fieldKind === 'scalar' && field.scalar === 8) {
        json[field.name] = value === 1n || value === 1;
      } else if (field.fieldKind === 'scalar' && field.scalar === 12) {
        json[field.name] = Buffer.from(Schema.decodeUnknownSync(Schema.instanceOf(Uint8Array))(value)).toString(
          'base64',
        );
      } else if (field.fieldKind === 'message' || field.fieldKind === 'list' || field.fieldKind === 'map') {
        json[field.name] = Schema.decodeUnknownSync(Schema.Json)(
          JSON.parse(Schema.decodeUnknownSync(Schema.String)(value)),
        );
      } else if (field.fieldKind === 'enum' || (field.fieldKind === 'scalar' && field.scalar !== 9)) {
        json[field.name] = Number(value);
      } else {
        json[field.name] = Schema.decodeUnknownSync(Schema.String)(value);
      }
    }

    return fromJsonString(schema, JSON.stringify(json));
  }
}
