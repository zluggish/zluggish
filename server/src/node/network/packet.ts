import { createCipheriv, createDecipheriv } from 'node:crypto';

export interface InitializationVector {
  device: number;
  channel: number;
  connection: number;
  sequence: number;
}

export interface PacketHeader {
  relay?: number;
  connection?: number;
  sequence?: number;
}

function nonce(iv: InitializationVector) {
  const data = Buffer.alloc(12);
  data.writeInt16BE(iv.device, 2);
  data.writeInt16BE(iv.channel, 4);
  data.writeInt16BE(iv.connection, 6);
  data.writeInt32BE(iv.sequence, 8);

  return data;
}

function algorithm(key: Uint8Array) {
  switch (key.length) {
    case 16: {
      return 'aes-128-gcm';
    }

    case 24: {
      return 'aes-192-gcm';
    }

    case 32: {
      return 'aes-256-gcm';
    }

    default: {
      throw new Error('Invalid AES key length');
    }
  }
}

export function encodePacket(payload: Uint8Array, key: Uint8Array, iv: InitializationVector, fields: PacketHeader) {
  let flags = 0;
  const parts: Buffer[] = [];

  if (fields.relay !== undefined) {
    flags |= 4;
    const data = Buffer.alloc(4);
    data.writeInt32BE(fields.relay);
    parts.push(data);
  }

  if (fields.connection !== undefined) {
    flags |= 2;
    const data = Buffer.alloc(2);
    data.writeInt16BE(fields.connection);
    parts.push(data);
  }

  if (fields.sequence !== undefined) {
    flags |= 1;
    const data = Buffer.alloc(4);
    data.writeInt32BE(fields.sequence);
    parts.push(data);
  }

  const header = Buffer.concat([Buffer.from([flags]), ...parts]);

  const cipher = createCipheriv(algorithm(key), key, nonce(iv), {
    authTagLength: 4,
  });

  cipher.setAAD(header);

  return Buffer.concat([header, cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
}

/** Preserve the legacy receive contract: decrypted bytes include the four-byte trailer.
This deliberately does not claim to authenticate incoming packets. Callers must
parse the channel-specific body; do not use this as a general AEAD decrypt API.
*/
export function decodeLegacyPacket(data: Uint8Array, key: Uint8Array, iv: InitializationVector) {
  const buffer = Buffer.from(data);
  const flags = buffer[0];

  if (flags === undefined || flags & ~7) throw new Error('Invalid packet flags');
  let offset = 1;
  const fields: PacketHeader = {};

  const take = (size: number) => {
    if (offset + size > buffer.length) throw new Error('Truncated packet header');
    const start = offset;
    offset += size;

    return start;
  };

  if (flags & 4) fields.relay = buffer.readUInt32BE(take(4));

  if (flags & 2) fields.connection = buffer.readUInt16BE(take(2));

  if (flags & 1) fields.sequence = buffer.readUInt32BE(take(4));

  const actual = {
    ...iv,
    connection: fields.connection ?? iv.connection,
    sequence: fields.sequence ?? iv.sequence,
  };

  if (buffer.length - offset < 4) throw new Error('Missing packet trailer');

  const decipher = createDecipheriv(algorithm(key), key, nonce(actual), {
    authTagLength: 4,
  });

  // The Python implementation calls decrypt without verify, including the tag bytes.
  // No final() call: Node correctly rejects an unauthenticated GCM finalization.
  return {
    fields,
    iv: actual,
    payload: decipher.update(buffer.subarray(offset)),
  };
}

/** Bounded accumulator for length-prefixed TCP frames, independent of chunk boundaries. */
export class FrameDecoder {
  private pending = Buffer.alloc(0);

  push(chunk: Uint8Array): Buffer[] {
    const frames: Buffer[] = [];
    let incoming = Buffer.from(chunk);

    while (incoming.length > 0) {
      if (this.pending.length < 2) {
        const size = Math.min(2 - this.pending.length, incoming.length);
        this.pending = Buffer.concat([this.pending, incoming.subarray(0, size)]);
        incoming = incoming.subarray(size);
      }

      if (this.pending.length < 2) break;
      const length = this.pending.readUInt16BE(0);

      if (length === 0) throw new Error('Empty TCP frame');
      const size = Math.min(length + 2 - this.pending.length, incoming.length);
      this.pending = Buffer.concat([this.pending, incoming.subarray(0, size)]);
      incoming = incoming.subarray(size);

      if (this.pending.length !== length + 2) {
        continue;
      }

      frames.push(this.pending.subarray(2));
      this.pending = Buffer.alloc(0);
    }

    return frames;
  }

  finish() {
    if (this.pending.length > 0) throw new Error('Truncated TCP frame');
  }
}
