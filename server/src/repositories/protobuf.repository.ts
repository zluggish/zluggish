import type { DescMessage } from '@bufbuild/protobuf';
import { fromJsonString, toJsonString } from '@bufbuild/protobuf';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';

export type ProtobufMessage<Schema extends DescMessage> = ReturnType<typeof fromJsonString<Schema>>;

export type Table = 'activity' | 'goal' | 'segment_result' | 'route_result';

export class ProtobufRows {
  constructor(readonly db: DatabaseSync) {}

  values<Schema extends DescMessage>(
    table: Table,
    schema: Schema,
    message: ProtobufMessage<Schema>,
    exclude: string[] = [],
  ) {
    const json = z.record(z.string(), z.json()).parse(
      JSON.parse(
        toJsonString(schema, message, {
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
      if (!columns.has(field.name) || exclude.includes(field.name) || !(field.name in json)) continue;
      const value = json[field.name];

      if (value === undefined) continue;

      if (field.fieldKind === 'scalar' && [3, 4, 6, 16, 18].includes(field.scalar)) {
        values.set(field.name, BigInt.asIntN(64, BigInt(z.union([z.string(), z.number()]).parse(value))));
      } else if (field.fieldKind === 'scalar' && field.scalar === 8) values.set(field.name, value ? 1 : 0);
      else if (field.fieldKind === 'scalar' && field.scalar === 12)
        values.set(field.name, Buffer.from(z.string().parse(value), 'base64'));
      else {
        const scalar = z.union([z.string(), z.number(), z.null()]).safeParse(value);

        values.set(field.name, scalar.success ? scalar.data : JSON.stringify(value));
      }
    }

    return values;
  }

  insert<Schema extends DescMessage>(
    table: Table,
    schema: Schema,
    message: ProtobufMessage<Schema>,
    exclude: string[] = [],
  ) {
    const values = this.values(table, schema, message, ['id', ...exclude]);
    const keys = values.keys().toArray();

    if (keys.length === 0) throw new Error('Empty database record');

    return this.db
      .prepare(
        `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      )
      .run(...values.values()).lastInsertRowid;
  }

  update<Schema extends DescMessage>(
    table: Table,
    id: bigint,
    schema: Schema,
    message: ProtobufMessage<Schema>,
    exclude: string[] = [],
  ) {
    const values = this.values(table, schema, message, ['id', ...exclude]);

    if (values.size > 0)
      this.db
        .prepare(
          `UPDATE "${table}" SET ${values
            .keys()
            .map((key) => `"${key}"=?`)
            .toArray()
            .join(',')} WHERE id=?`,
        )
        .run(...values.values(), id);
  }

  select<Schema extends DescMessage>(table: Table, schema: Schema, playerId: bigint): ProtobufMessage<Schema>[] {
    const query = this.db.prepare(`SELECT * FROM "${table}" WHERE player_id=? ORDER BY id`);

    query.setReadBigInts(true);

    return query.all(playerId).map((row) => this.decode(schema, row));
  }

  decode<Schema extends DescMessage>(
    schema: Schema,
    row: Record<string, import('node:sqlite').SQLOutputValue>,
  ): ProtobufMessage<Schema> {
    const json: Record<string, z.infer<ReturnType<typeof z.json>>> = {};

    for (const field of schema.fields) {
      const value = row[field.name];

      if (value === null || value === undefined || field.name === 'fit') continue;

      if (field.fieldKind === 'scalar' && [3, 4, 6, 16, 18].includes(field.scalar)) {
        json[field.name] = String(
          field.scalar === 4 || field.scalar === 6
            ? BigInt.asUintN(64, BigInt(z.union([z.number(), z.bigint()]).parse(value)))
            : value,
        );
      } else if (field.fieldKind === 'scalar' && field.scalar === 8) json[field.name] = value === 1n || value === 1;
      else if (field.fieldKind === 'scalar' && field.scalar === 12)
        json[field.name] = Buffer.from(z.instanceof(Uint8Array).parse(value)).toString('base64');
      else if (field.fieldKind === 'message' || field.fieldKind === 'list' || field.fieldKind === 'map')
        json[field.name] = z.json().parse(JSON.parse(z.string().parse(value)));
      else if (field.fieldKind === 'enum' || (field.fieldKind === 'scalar' && field.scalar !== 9))
        json[field.name] = Number(value);
      else json[field.name] = z.string().parse(value);
    }

    return fromJsonString(schema, JSON.stringify(json));
  }
}
