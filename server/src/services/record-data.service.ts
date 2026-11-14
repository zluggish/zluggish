import type { RepositoryContext } from '#src/context';
import type { ProtobufMessage, ProtobufRows, Table } from '#src/repositories/protobuf.repository';
import { BaseService } from '#src/services/base.service';
import type { DescMessage } from '@bufbuild/protobuf';

export class RecordDataService extends BaseService {
  constructor(context: RepositoryContext) {
    super(context.accounts.repositories);
  }

  insert<Schema extends DescMessage>(
    table: Table,
    schema: Schema,
    message: ProtobufMessage<Schema>,
    exclude: string[] = [],
  ) {
    return this.protobufRepository.insert(table, schema, message, exclude);
  }

  update<Schema extends DescMessage>(
    table: Table,
    id: bigint,
    schema: Schema,
    message: ProtobufMessage<Schema>,
    exclude: string[] = [],
  ) {
    this.protobufRepository.update(table, id, schema, message, exclude);
  }

  select<Schema extends DescMessage>(table: Table, schema: Schema, playerId: bigint) {
    return this.protobufRepository.select(table, schema, playerId);
  }

  decode<Schema extends DescMessage>(schema: Schema, row: Parameters<ProtobufRows['decode']>[1]) {
    return this.protobufRepository.decode(schema, row);
  }
}
