import type { DescMessage } from '@bufbuild/protobuf';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { HTTPException } from 'hono/http-exception';

export function parseProtobuf<Schema extends DescMessage>(schema: Schema, bytes: Uint8Array) {
  try {
    const message = fromBinary(schema, bytes);
    // Decoding accepts absent proto2 required fields; serialization validates them.
    toBinary(schema, message);

    return message;
  } catch {
    throw new HTTPException(400, { message: 'Invalid request' });
  }
}
