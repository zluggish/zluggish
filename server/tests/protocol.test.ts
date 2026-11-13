import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromBinary, toBinary, isFieldSet } from '@bufbuild/protobuf';
import { z } from 'zod';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import type { PacketHeader } from '#src/node/network/packet';
import { encodePacket, decodeLegacyPacket, FrameDecoder } from '#src/node/network/packet';
import { decryptCredentials, encryptCredentials } from '#src/node/persistence/credentials';
import { verifyPassword, signIdentity, verifyIdentity } from '#src/domain/accounts/passwords';

const fixtures = z
  .object({
    key: z.string(),
    payload: z.string(),
    packets: z.array(z.object({ flags: z.number(), wire: z.string(), decrypted: z.string() })),
    credentialKey: z.string(),
    credentials: z.string(),
    password: z.string(),
    scryptHash: z.string(),
    sha256Hash: z.string(),
    profile: z.string(),
    secret: z.string(),
    identity: z.string(),
    cookie: z.string(),
  })
  .parse(JSON.parse(readFileSync(new URL('fixtures/python.json', import.meta.url), 'utf8')));

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

await test('credentials use Python CFB8 encoding, not CFB128', () => {
  const key = Buffer.from(fixtures.credentialKey, 'hex');
  const wire = Buffer.from(fixtures.credentials, 'hex');
  assert.deepEqual(decryptCredentials(key, wire), ['example-user', 'example-password']);
  assert.equal(
    encryptCredentials(key, ['example-user', 'example-password'], wire.subarray(0, 16)).toString('hex'),
    fixtures.credentials,
  );
});

await test('proto2 64-bit values, explicit false presence and unknown fields survive updates', () => {
  const bytes = Buffer.from(fixtures.profile, 'hex');
  const profile = fromBinary(PlayerProfileSchema, bytes);
  assert.equal(profile.id, 9_223_372_036_854_775_807n);
  assert.equal(profile.isMale, false);
  profile.firstName = 'Updated';
  const encoded = toBinary(PlayerProfileSchema, profile);
  const decoded = fromBinary(PlayerProfileSchema, encoded);
  assert.equal(decoded.firstName, 'Updated');
  assert.equal(decoded.isMale, false);
  assert.ok(isFieldSet(decoded, PlayerProfileSchema.field.isMale));
  assert.deepEqual(
    decoded.$unknown?.map((field) => ({
      ...field,
      data: [...field.data],
    })),
    profile.$unknown?.map((field) => ({
      ...field,
      data: [...field.data],
    })),
  );
  assert.ok(profile.$unknown?.length);
});

await test('Werkzeug hashes and Flask-Login signed identities remain interoperable', async () => {
  assert.equal(await verifyPassword(fixtures.scryptHash, fixtures.password), true);
  assert.equal(await verifyPassword(fixtures.sha256Hash, fixtures.password), true);
  assert.equal(await verifyPassword(fixtures.scryptHash, 'wrong'), false);
  assert.equal(await verifyPassword(null, fixtures.password), false);
  const secret = Buffer.from(fixtures.secret, 'hex');
  assert.equal(signIdentity(fixtures.identity, secret), fixtures.cookie);
  assert.equal(verifyIdentity(fixtures.cookie, secret), fixtures.identity);
  assert.equal(verifyIdentity(fixtures.cookie.replace('42:7', '43:7'), secret), null);
});

await test('proto2 required fields are enforced on serialization', async () => {
  const { LoginRequestSchema } = await import('#src/protocol/generated/login_pb');

  const decoded = fromBinary(LoginRequestSchema, new Uint8Array());
  assert.throws(() => toBinary(LoginRequestSchema, decoded), /required field not set/);
});
