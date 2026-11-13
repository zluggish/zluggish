import { companionProfile } from '#src/domain/profiles/json';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import { create } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';

await test('Companion profiles retain DOB age, equipment, attributes and numeric IDs', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 13) });

  const profile = create(PlayerProfileSchema, {
    id: 1n,
    serverRealm: 1n,
    currentActivityId: 9_007_199_254_740_991n,
    firstName: 'Rider',
    dob: '11/14/2000',
    bikeFrame: 2_454_550,
    isMale: false,
    publicAttributes: [{ id: 7, numberValue: 123n }],
    privateAttributes: [{ id: 8, stringValue: 'value' }],
  });

  const json = companionProfile(profile, '/avatar');
  assert.equal(json.age, 25);
  assert.equal(json.virtualBikeModel, 'Ventum One');
  assert.equal(json.currentActivityId, 9_007_199_254_740_991);
  assert.equal(json.worldId, 1);
  assert.equal(json.male, false);
  assert.deepEqual(json.publicAttributes, { 7: '123' });
  assert.deepEqual(json.privateAttributes, { 8: 'value' });
  profile.dob = '11/13/2000';
  assert.equal(companionProfile(profile, null).age, 26);
  profile.dob = '02/30/2000';
  assert.equal(companionProfile(profile, null).age, profile.age);
  profile.currentActivityId = 9_007_199_254_740_992n;
  assert.throws(() => companionProfile(profile, null), z.ZodError);
});
