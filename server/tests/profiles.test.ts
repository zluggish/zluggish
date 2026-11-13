import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, fromBinary, isFieldSet, toBinary } from '@bufbuild/protobuf';
import { runtimeFixture } from '#tests/support/runtime';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';

await test('in-game profile updates preserve absent fields, unknown fields and explicit zero values', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Profile Rider', '', true);

  const original = fromBinary(
    PlayerProfileSchema,
    Buffer.concat([
      toBinary(
        PlayerProfileSchema,
        create(PlayerProfileSchema, {
          id: BigInt(user.player_id),
          firstName: 'Profile',
          lastName: 'Rider',
          weightInGrams: 75_000,
          totalXp: 12_345,
          isMale: true,
        }),
      ),
      Buffer.from('a01f07', 'hex'),
    ]),
  );

  f.profiles.save(user.player_id, original);

  const response = await f.app.request(`/api/profiles/${user.player_id}/in-game-fields`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}` },
    body: toBinary(
      PlayerProfileSchema,
      create(PlayerProfileSchema, { id: BigInt(user.player_id), totalXp: 0, isMale: false }),
    ),
  });

  assert.equal(response.status, 204);
  const saved = f.profiles.get(user.player_id);
  assert.equal(saved.firstName, 'Profile');
  assert.equal(saved.lastName, 'Rider');
  assert.equal(saved.weightInGrams, 75_000);
  assert.equal(saved.totalXp, 0);
  assert.equal(saved.isMale, false);
  assert.ok(isFieldSet(saved, PlayerProfileSchema.field.isMale));
  assert.deepEqual(saved.$unknown, original.$unknown);
  assert.equal(f.accounts.get(user.player_id)?.first_name, 'Profile');
});
