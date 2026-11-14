import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import { pythonFixtures as fixtures } from '#tests/support/python';
import { fromBinary, isFieldSet, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { test } from 'node:test';

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

await test('proto2 required fields are enforced on serialization', async () => {
  const { LoginRequestSchema } = await import('#src/protocol/generated/login_pb');

  const decoded = fromBinary(LoginRequestSchema, new Uint8Array());
  assert.throws(() => toBinary(LoginRequestSchema, decoded), /required field not set/);
});
