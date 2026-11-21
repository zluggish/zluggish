import { inputValue } from '#tests/support/html';
import {
  LoginRequestSchema,
  LoginResponseSchema,
  RelaySessionRefreshResponseSchema,
} from '#src/protocol/generated/login_pb';
import { PlaybackDataSchema, PlaybackMetadataSchema } from '#src/protocol/generated/playback_pb';
import { PlayerProfilesSchema } from '#src/protocol/generated/profile_pb';
import { DropInWorldSchema } from '#src/protocol/generated/world_pb';
import {
  SaveStructuredEventRequestSchema,
  SaveStructuredEventResponseSchema,
} from '#src/protocol/generated/structured_events_pb';
import { PlayerStateSchema, RideOnSchema, WA_TYPE } from '#src/protocol/generated/udp-node-msgs_pb';
import { worldTime } from '#src/world/state';
import { binary, decode, mediumBrowser, mediumFixture } from '#tests/medium/support';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Schema } from 'effect';

await test('realm listings require authentication and preserve JSON and protobuf rider details', async (t) => {
  const f = await mediumFixture(t);
  const state = create(PlayerStateSchema, {
    id: BigInt(f.rider.player_id),
    f19: 17 << 16,
    distance: 1234,
    time: 567,
    power: 210,
    x: 42,
    z: 84,
  });
  f.world.online.set(state.id, state);

  for (const path of ['/relay/worlds/1', '/relay/worlds/1/']) {
    for (const accept of ['application/json', 'application/x-protobuf-lite']) {
      const headers = { Accept: accept };
      const anonymous = await f.app.request(path, { headers });
      assert.equal(anonymous.status, 401);
      assert.equal(await anonymous.text(), '');

      const invalid = await f.app.request(path, {
        headers: { ...headers, Authorization: 'Bearer invalid' },
      });
      assert.equal(invalid.status, 401);

      const response = await f.request(path, { headers });
      if (accept === 'application/json') {
        assert.equal(response.status, 200);
        const world = Schema.decodeUnknownSync(
          Schema.Struct({
            worldId: Schema.Number,
            playerCount: Schema.Number,
            friendsInWorld: Schema.Array(
              Schema.Struct({
                playerId: Schema.Number,
                firstName: Schema.String,
                lastName: Schema.String,
                totalDistanceInMeters: Schema.Number,
                rideDurationInSeconds: Schema.Number,
              }),
            ),
          }),
        )(await response.json());
        assert.equal(world.worldId, 1);
        assert.equal(world.playerCount, 1);
        assert.deepEqual(world.friendsInWorld, [
          {
            playerId: f.rider.player_id,
            firstName: 'Medium',
            lastName: 'Rider',
            totalDistanceInMeters: 1234,
            rideDurationInSeconds: 567,
          },
        ]);
      } else {
        const world = await decode(response, DropInWorldSchema);
        assert.equal(world.id, 1n);
        assert.equal(world.zwifters, 1n);
        assert.equal(world.followees.length, 1);
        const rider = world.followees[0]!;
        assert.equal(rider.id, state.id);
        assert.equal(rider.firstName, 'Medium');
        assert.equal(rider.lastName, 'Rider');
        assert.equal(rider.distance, 1234n);
        assert.equal(rider.time, 567n);
        assert.equal(rider.power, 210n);
        assert.equal(rider.x, 42);
        assert.equal(rider.z, 84);
      }
    }
  }
});

await test('Calendar clears pending map and climb selections for the launching client', async (t) => {
  const f = await mediumFixture(t);
  const browser = await mediumBrowser(f);
  f.world.mapOverrides.set('other-client', '7');
  f.world.climbOverrides.set('other-client', '10002');

  assert.equal(f.settings.read(f.rider.player_id)['ghosts.enabled'], undefined);
  const selected = await browser.form('/start-zwift', { map: '6', climb: '10001' });
  assert.equal(f.settings.read(f.rider.player_id)['ghosts.enabled'], undefined);
  f.settings.save(f.rider.player_id, { 'ghosts.enabled': false });
  assert.equal(selected.status, 302);
  assert.equal(f.world.mapOverrides.get(''), '6');
  assert.equal(f.world.climbOverrides.get(''), '10001');

  const calendarMap = await browser.form('/start-zwift', { map: 'CALENDAR', climb: '10001' });
  assert.equal(calendarMap.status, 302);
  assert.equal(f.world.mapOverrides.has(''), false);
  assert.equal(f.world.climbOverrides.get(''), '10001');

  const calendarClimb = await browser.form('/start-zwift', { map: '7', climb: 'CALENDAR' });
  assert.equal(calendarClimb.status, 302);
  assert.equal(f.world.mapOverrides.get(''), '7');
  assert.equal(f.world.climbOverrides.has(''), false);

  const calendar = await browser.form('/start-zwift', { map: 'CALENDAR', climb: 'CALENDAR' });
  assert.equal(calendar.status, 302);
  assert.equal(f.settings.read(f.rider.player_id)['ghosts.enabled'], false);
  assert.equal(f.world.mapOverrides.has(''), false);
  assert.equal(f.world.climbOverrides.has(''), false);
  assert.equal(f.world.mapOverrides.get('other-client'), '7');
  assert.equal(f.world.climbOverrides.get('other-client'), '10002');
});

{
  await test('browser rider selection, CSRF settings/download, launch, switch and logout', async (t) => {
    const f = await mediumFixture(t);
    let cookie = '';
    let csrf = '';

    const request = async (path: string, init: RequestInit = {}) => {
      const response = await f.app.request(path, { ...init, headers: { Cookie: cookie } });
      cookie = response.headers.getSetCookie().at(-1)?.split(';', 1)[0] ?? cookie;
      const text = await response.clone().text();
      csrf = inputValue(text, 'csrf_token') ?? csrf;

      return response;
    };

    const form = (path: string, fields: Record<string, string> = {}) =>
      request(path, { method: 'POST', body: new URLSearchParams({ csrf_token: csrf, ...fields }) });

    const response1 = await request('/login/');
    assert.equal(response1.status, 200);

    const response2 = await form('/login/', {
      player_id: String(f.rider.player_id),
      step: 'password',
      password: 'test-password',
    });

    assert.equal(response2.status, 302);
    const response3 = await request(`/user/${f.rider.username}/`);
    assert.equal(response3.status, 200);
    const response6 = await form('/start-zwift', { map: '6', climb: '10001' });
    assert.equal(response6.status, 302);
    assert.equal(f.world.mapOverrides.get(''), '6');
    assert.equal(f.world.climbOverrides.get(''), '10001');
    const ride = await request('/ride');
    assert.equal(ride.status, 302);
    assert.match(ride.headers.get('Location') ?? '', /^http:\/\/zwift\/\?code=zwift_refresh_token/);
    const response7 = await form('/riders/switch/');
    assert.equal(response7.status, 302);
    const response8 = await request('/api/profiles/me');
    assert.equal(response8.status, 401);
  });
}

{
  await test('game login establishes relay key, refresh/renew work and logout clears session', async (t) => {
    const f = await mediumFixture(t);

    const login = await decode(
      await f.request('/api/users/login', {
        method: 'POST',
        ...binary(LoginRequestSchema, { key: new Uint8Array(16).fill(7) }),
      }),
      LoginResponseSchema,
    );

    assert.ok(login);

    for (const action of ['refresh', 'renew']) {
      const refreshed = await decode(
        await f.request(`/relay/session/${action}`, { method: 'POST' }),
        RelaySessionRefreshResponseSchema,
      );

      assert.ok(refreshed);
    }

    const state = create(PlayerStateSchema, { id: BigInt(f.rider.player_id), roadTime: 1, worldTime: worldTime() });
    f.world.receive(BigInt(f.rider.player_id), state);
    const response9 = await decode(await f.request(`/relay/worlds/1/players/${f.rider.player_id}`), PlayerStateSchema);
    assert.equal(response9.id, state.id);
    const response10 = await f.request('/api/users/logout', { method: 'POST' });
    assert.equal(response10.status, 204);
    assert.equal(f.world.online.has(state.id), false);
  });
}

{
  await test('social search, profile lookup, phone pairing and ride-on queue preserve rider identity', async (t) => {
    const f = await mediumFixture(t);

    const profiles = await decode(
      await f.app.request(`/api/profiles?id=${f.rider.player_id}&id=${f.other.player_id}`),
      PlayerProfilesSchema,
    );

    assert.deepEqual(
      profiles.profiles.map((p) => p.firstName),
      ['Medium', 'Other'],
    );

    for (const path of ['/api/search/profiles', '/api/search/profiles/restricted']) {
      const response = await f.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"query":"Medium"}',
      });

      assert.equal(
        Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.Finite })))(await response.json())[0]?.id,
        f.rider.player_id,
      );
    }

    const response11 = await f.request('/relay/profiles/me/phone', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{"phoneAddress":"127.0.0.2","port":1234}',
    });

    assert.equal(response11.status, 204);
    assert.equal(f.world.phones.get(BigInt(f.rider.player_id))?.zcLocalPort, 1234);
    const response12 = await f.request(`/api/profiles/${f.other.player_id}/activities/0/rideon`, { method: 'POST' });
    assert.equal(response12.status, 200);
    const queued = f.world.updates.get(BigInt(f.other.player_id))?.find((a) => a.waType === WA_TYPE.WAT_RIDE_ON);
    assert.ok(queued);
    assert.equal(fromBinary(RideOnSchema, queued.payload).playerId, BigInt(f.rider.player_id));
  });
}

await test('playback upload, metadata selection and public byte download round-trip', async (t) => {
  const f = await mediumFixture(t);
  const payload = { segmentId: 42n, time: 123, worldTime: worldTime() };

  const response = await f.request('/api/player-playbacks/player/playback', {
    method: 'POST',
    ...binary(PlaybackDataSchema, payload),
  });

  assert.equal(response.status, 201);
  const uuid = await response.text();

  const metadata = await decode(
    await f.request('/api/player-playbacks/player/me/playbacks/42/pr'),
    PlaybackMetadataSchema,
  );

  assert.equal(metadata.uuid, uuid);
  assert.equal(metadata.time, 123);
  const download = await f.app.request(new URL(metadata.url).pathname);
  assert.equal(download.status, 200);
  assert.deepEqual(
    new Uint8Array(await download.arrayBuffer()),
    toBinary(PlaybackDataSchema, create(PlaybackDataSchema, payload)),
  );
});

{
  await test('structured event acknowledgement echoes the submitted sequence', async (t) => {
    const f = await mediumFixture(t);

    const response = await f.app.request('/api/actions-service/structured-events/batch', {
      method: 'POST',
      ...binary(SaveStructuredEventRequestSchema, { sequenceNumber: 12_345 }),
    });

    const response13 = await decode(response, SaveStructuredEventResponseSchema, 202);
    assert.equal(response13.sequenceNumber, 12_345);
  });
}
