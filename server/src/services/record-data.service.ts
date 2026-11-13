import type { ProtobufMessage, ProtobufRows, Table } from '#src/repositories/protobuf.repository';
import type { DescMessage } from '@bufbuild/protobuf';

export class RecordDataService {
  constructor(private readonly repository: ProtobufRows) {}
  insert<Schema extends DescMessage>(
    table: Table,
    schema: Schema,
    message: ProtobufMessage<Schema>,
    exclude: string[] = [],
  ) {
    return this.repository.insert(table, schema, message, exclude);
  }
  update<Schema extends DescMessage>(
    table: Table,
    id: bigint,
    schema: Schema,
    message: ProtobufMessage<Schema>,
    exclude: string[] = [],
  ) {
    this.repository.update(table, id, schema, message, exclude);
  }
  select<Schema extends DescMessage>(table: Table, schema: Schema, playerId: bigint) {
    return this.repository.select(table, schema, playerId);
  }
  decode<Schema extends DescMessage>(schema: Schema, row: Parameters<ProtobufRows['decode']>[1]) {
    return this.repository.decode(schema, row);
  }
}
