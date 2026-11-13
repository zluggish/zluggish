import type { PacketHeader } from '#src/node/network/packet';
import { decodePacket, encodePacket, FrameDecoder } from '#src/node/network/packet';
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
    assert.equal(decodePacket(encoded, Buffer.from(fixtures.key, 'hex'), iv).payload.toString('hex'), fixtures.payload);
  }
});

await test('packet authentication rejects tampered packets, wrong keys and wrong nonces', () => {
  const key = Buffer.from(fixtures.key, 'hex');
  const iv = { device: 1, channel: 2, connection: 7, sequence: 42 };

  const packet = encodePacket(Buffer.from(fixtures.payload, 'hex'), key, iv, {
    relay: 123,
    connection: 7,
    sequence: 42,
  });

  // Cover every optional header field, the ciphertext and the authentication tag.
  for (const offset of [1, 5, 7, 11, packet.length - 1]) {
    const modified = Buffer.from(packet);
    modified[offset] = (modified[offset] ?? 0) ^ 1;
    assert.throws(() => decodePacket(modified, key, iv));
  }

  const wrongKey = Buffer.from(key);
  wrongKey[0] = (wrongKey[0] ?? 0) ^ 1;
  assert.throws(() => decodePacket(packet, wrongKey, iv));
  assert.throws(() => decodePacket(packet, key, { ...iv, channel: 3 }));
  assert.throws(() => decodePacket(packet.subarray(0, -1), key, iv));
  const implicit = encodePacket(Buffer.from(fixtures.payload, 'hex'), key, iv, {});
  assert.throws(() => decodePacket(implicit, key, { ...iv, sequence: 43 }));
});

await test('authenticated packets support all AES key sizes and empty bodies', () => {
  const iv = { device: 1, channel: 2, connection: 7, sequence: 42 };

  for (const size of [16, 24, 32]) {
    const key = Buffer.alloc(size, 1);
    assert.deepEqual(decodePacket(encodePacket(Buffer.alloc(0), key, iv, {}), key, iv).payload, Buffer.alloc(0));
  }
});

await test('packet headers reject malformed bounds', () => {
  const iv = { device: 1, channel: 2, connection: 7, sequence: 42 };
  const key = Buffer.from(fixtures.key, 'hex');
  assert.throws(() => decodePacket(Buffer.from([4]), key, iv), /Truncated/);
  assert.throws(() => decodePacket(Buffer.from([128]), key, iv), /flags/);
  assert.throws(() => decodePacket(Buffer.from([0]), key, iv), /tag/);
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
