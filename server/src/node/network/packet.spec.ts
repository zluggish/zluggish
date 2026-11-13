import type { PacketHeader } from '#src/node/network/packet';
import { decodeLegacyPacket, encodePacket, FrameDecoder } from '#src/node/network/packet';
import { pythonFixtures as fixtures } from '#tests/support/python';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('AES-GCM packets match Python byte-for-byte for every header combination', () => {
  for (const vector of fixtures.packets) {
    const fields: PacketHeader = {};

    if (vector.flags & 4) fields.relay = 123;

    if (vector.flags & 2) fields.connection = 7;

    if (vector.flags & 1) fields.sequence = 42;
    const iv = { device: 1, channel: 2, connection: 7, sequence: 42 };

    const encoded = encodePacket(Buffer.from(fixtures.payload, 'hex'), Buffer.from(fixtures.key, 'hex'), iv, fields);

    assert.equal(encoded.toString('hex'), vector.wire);
    assert.equal(
      decodeLegacyPacket(encoded, Buffer.from(fixtures.key, 'hex'), iv).payload.toString('hex'),
      vector.decrypted,
    );
  }
});

await test('packet headers reject malformed bounds', () => {
  const iv = { device: 1, channel: 2, connection: 7, sequence: 42 };
  const key = Buffer.from(fixtures.key, 'hex');
  assert.throws(() => decodeLegacyPacket(Buffer.from([4]), key, iv), /Truncated/);
  assert.throws(() => decodeLegacyPacket(Buffer.from([128]), key, iv), /flags/);
  assert.throws(() => decodeLegacyPacket(Buffer.from([0]), key, iv), /trailer/);
});

await test('TCP frames handle every fragmentation boundary and multiple coalesced frames', () => {
  const encoded = Buffer.from('000361626300026465', 'hex');

  for (let split = 0; split <= encoded.length; split++) {
    const decoder = new FrameDecoder();

    const result = [...decoder.push(encoded.subarray(0, split)), ...decoder.push(encoded.subarray(split))];

    assert.deepEqual(
      result.map((frame) => frame.toString()),
      ['abc', 'de'],
    );
    decoder.finish();
  }

  const decoder = new FrameDecoder();
  decoder.push(Buffer.from([0]));
  assert.throws(() => decoder.finish(), /Truncated/);
  assert.throws(() => new FrameDecoder().push(Buffer.from([0, 0])), /Empty/);
});
