import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { mediumFixture, binary, decode } from '#tests/medium/support';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';

const profileJSON = z.object({
  id: z.number(),
  age: z.number(),
  worldId: z.number(),
  currentActivityId: z.number(),
  male: z.boolean(),
  useMetric: z.boolean(),
  imageSrc: z.string().nullable(),
  virtualBikeModel: z.string(),
  publicAttributes: z.record(z.string(), z.union([z.string(), z.number()])),
  privateAttributes: z.record(z.string(), z.union([z.string(), z.number()])),
  profilePropertyChanges: z.array(z.object({ propertyName: z.string(), changeCount: z.number() })),
  userAgent: z.string(),
  launchedGameClient: z.string(),
  createdOn: z.string(),
  bt: z.string(),
});

await test('F13 Companion profile reads preserve numeric IDs, DOB age, equipment, explicit false and attribute maps', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 13, 12) });
  const f = await mediumFixture(t);

  const saved = await f.request(`/api/profiles/${f.rider.player_id}`, {
    method: 'PUT',
    ...binary(PlayerProfileSchema, {
      firstName: 'Companion',
      lastName: 'Rider',
      dob: '11/14/2000',
      age: 3,
      bikeFrame: 2_454_550,
      isMale: false,
      useMetric: false,
      serverRealm: 1n,
      currentActivityId: 9_007_199_254_740_991n,
      publicAttributes: [
        { id: 7, numberValue: 9_223_372_036_854_775_807n },
        { id: 8, floatValue: 1.5 },
      ],
      privateAttributes: [{ id: 9, stringValue: 'setting' }],
      propertyChanges: [{ propertyName: 1, changeCount: 2 }],
    }),
  });

  assert.equal(saved.status, 204);

  for (const path of ['/api/profiles/me', `/api/profiles/${f.rider.player_id}`]) {
    const response = await f.request(path, { headers: { Accept: 'application/json' } });
    assert.equal(response.status, 200);
    const json = profileJSON.parse(await response.json());
    assert.equal(json.id, f.rider.player_id);
    assert.equal(json.age, 25);
    assert.equal(json.worldId, 1);
    assert.equal(json.currentActivityId, 9_007_199_254_740_991);
    assert.equal(json.male, false);
    assert.equal(json.useMetric, false);
    assert.equal(json.virtualBikeModel, 'Ventum One');
    assert.deepEqual(json.publicAttributes, { 7: '9223372036854775807', 8: 1.5 });
    assert.deepEqual(json.privateAttributes, { 9: 'setting' });
    assert.equal(json.profilePropertyChanges[0]?.propertyName, 'DATE_OF_BIRTH');
    assert.match(json.userAgent, /Android/);
    assert.ok(json.launchedGameClient && json.createdOn && json.bt);
  }

  t.mock.timers.tick(86_400_000);
  const birthday = await f.request('/api/profiles/me', { headers: { Accept: 'application/json' } });
  assert.equal(profileJSON.parse(await birthday.json()).age, 26);
  const binaryProfile = await decode(await f.request('/api/profiles/me'), PlayerProfileSchema);
  assert.equal(binaryProfile.currentActivityId, 9_007_199_254_740_991n);
  assert.equal(binaryProfile.publicAttributes[0]?.numberValue, 9_223_372_036_854_775_807n);
});

await test('F13 profile edits negotiate JSON/protobuf and preserve avatar URLs and account names', async (t) => {
  const f = await mediumFixture(t);
  const image = new Uint8Array([255, 216, 255, 217]);
  const uploaded = await f.request(`/api/profiles/${f.rider.player_id}/photo`, { method: 'POST', body: image });
  assert.equal(uploaded.status, 200);
  const path = `/api/profiles/me/${f.rider.player_id}`;

  const edited = await f.request(path, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Changed', lastName: 'Name', dob: '02/30/2000' }),
  });

  assert.equal(edited.status, 200);

  const json = z
    .object({
      firstName: z.string(),
      lastName: z.string(),
      imageSrc: z.string(),
      imageSrcLarge: z.string(),
      age: z.number(),
    })
    .parse(await edited.json());

  assert.equal(json.firstName, 'Changed');
  assert.equal(json.lastName, 'Name');
  assert.equal(json.age, 0);
  assert.equal(json.imageSrc, `https://us-or-rly101.zwift.com/download/${f.rider.player_id}/avatarLarge.jpg`);
  assert.equal(json.imageSrcLarge, json.imageSrc);
  const picture = await f.app.request(new URL(json.imageSrc).pathname);
  assert.deepEqual(new Uint8Array(await picture.arrayBuffer()), image);

  const binaryProfile = await decode(
    await f.request(path, {
      method: 'PUT',
      headers: { Accept: 'application/x-protobuf-lite', 'Content-Type': 'application/json' },
      body: JSON.stringify({ useMetric: false }),
    }),
    PlayerProfileSchema,
  );

  assert.equal(binaryProfile.useMetric, false);
  assert.equal(binaryProfile.firstName, 'Changed');
  assert.equal(f.accounts.get(f.rider.player_id)?.first_name, 'Changed');

  const denied = await f.request(
    path,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ firstName: 'Stolen' }) },
    f.other,
  );

  assert.equal(denied.status, 401);
  const unknown = await f.request('/api/profiles/999999');
  assert.equal(unknown.status, 404);
});

await test('F13 unsafe integer scalar values are rejected in Companion JSON while binary data remains exact', async (t) => {
  const f = await mediumFixture(t);

  const saved = await f.request(`/api/profiles/${f.rider.player_id}`, {
    method: 'PUT',
    ...binary(PlayerProfileSchema, { firstName: 'Large', currentActivityId: 9_007_199_254_740_992n }),
  });

  assert.equal(saved.status, 204);
  const json = await f.request('/api/profiles/me', { headers: { Accept: 'application/json' } });
  assert.equal(json.status, 400);
  assert.equal(await json.text(), 'Invalid request');
  const profile = await decode(await f.request('/api/profiles/me'), PlayerProfileSchema);
  assert.equal(profile.currentActivityId, 9_007_199_254_740_992n);
});
