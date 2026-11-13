import { writeDurable } from '#src/repositories/files.repository';
import { ActivityListSchema } from '#src/protocol/generated/activity_pb';
import { PlayerJoinedEventSchema } from '#src/protocol/generated/events_pb';
import { AchievementsSchema, PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import { RaceResultEntrySaveRequestSchema, RaceResultSummarySchema } from '#src/protocol/generated/race-result_pb';
import { PlayerStateSchema, WA_TYPE } from '#src/protocol/generated/udp-node-msgs_pb';
import { ZFileProtoSchema, ZFilesProtoSchema } from '#src/protocol/generated/zfiles_pb';
import { runtimeFixture } from '#tests/support/runtime';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';

await test('Companion and game zfiles negotiate independently and preserve overwrite metadata', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Files Rider', '', true);
  const other = await f.accounts.create('Other Rider', '');
  const authorization = { Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}` };

  for (const companion of [true, false])
    for (const json of [true, false]) {
      const response = await f.app.request('/api/zfiles', {
        method: 'POST',
        headers: {
          ...authorization,
          Source: companion ? 'zwift-companion' : 'game',
          Accept: json ? 'application/json' : 'application/x-protobuf-lite',
          'Content-Type': companion ? 'application/json' : 'application/x-protobuf-lite',
        },
        body: companion
          ? JSON.stringify({
              folder: 'customworkouts',
              name: 'test.zwo',
              content: Buffer.from('new bytes').toString('base64'),
            })
          : toBinary(
              ZFileProtoSchema,
              create(ZFileProtoSchema, {
                folder: 'customworkouts',
                filename: 'test.zwo',
                file: Buffer.from('game bytes'),
              }),
            ),
      });

      assert.equal(response.status, 200);

      if (json) {
        assert.match(response.headers.get('Content-Type') ?? '', /application\/json/);
        assert.deepEqual(await response.json(), {
          id: 1,
          folder: 'customworkouts',
          name: 'test.zwo',
          content: null,
          lastModified: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('Z', '+0000'),
        });
      } else assert.equal(fromBinary(ZFileProtoSchema, new Uint8Array(await response.arrayBuffer())).id, 1n);
    }

  f.accounts.db.prepare('UPDATE zfile SET timestamp=123 WHERE id=1').run();

  const overwrite = await f.app.request('/api/zfiles', {
    method: 'POST',
    headers: { ...authorization, Source: 'zwift-companion', Accept: 'application/json' },
    body: JSON.stringify({ folder: 'customworkouts', name: 'test.zwo', content: 'eA==' }),
  });

  assert.equal(
    z.object({ lastModified: z.string() }).parse(await overwrite.json()).lastModified,
    '1970-01-01T00:02:03.000+0000',
  );
  const listed = await f.app.request('/api/zfiles/list?folder=customworkouts', { headers: authorization });
  assert.equal(fromBinary(ZFilesProtoSchema, new Uint8Array(await listed.arrayBuffer())).zfiles[0]?.timestamp, 123n);
  const download = await f.app.request('/api/zfiles/1/download', { headers: authorization });
  assert.equal(await download.text(), 'x');

  for (const content of ['!!!', 'eA=']) {
    const invalid = await f.app.request('/api/zfiles', {
      method: 'POST',
      headers: { ...authorization, Source: 'zwift-companion' },
      body: JSON.stringify({ folder: 'customworkouts', name: 'bad.zwo', content }),
    });

    assert.equal(invalid.status, 400);
    assert.equal(existsSync(resolve(f.profiles.folder(user.player_id), 'customworkouts/bad.zwo')), false);
  }

  const malformed = await f.app.request('/api/zfiles', {
    method: 'POST',
    headers: { ...authorization, Source: 'zwift-companion', 'Content-Type': 'application/json' },
    body: '{',
  });

  assert.equal(malformed.status, 400);
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM zfile').get()?.n, 1);

  const forbidden = await f.app.request('/api/zfiles/1/download', {
    headers: { Authorization: `Bearer ${f.sessions.tokens(other, f.tokens).access_token}` },
  });

  assert.equal(forbidden.status, 404);
});

await test('multipart and raw avatars download as exact image bytes; malformed input cannot replace them', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Avatar Rider', '', true);
  const headers = { Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}` };
  const jpeg = Buffer.from([255, 216, 1, 2, 255, 217]);
  const form = new FormData();
  form.set('file', new File([jpeg], 'avatar.jpg', { type: 'image/jpeg' }));

  for (const body of [form, jpeg]) {
    const response = await f.app.request(`/api/profiles/${user.player_id}/photo`, { method: 'POST', headers, body });
    assert.equal(response.status, 200);
    const image = await f.app.request(`/download/${user.player_id}/avatarLarge.jpg`);
    assert.equal(image.headers.get('Content-Type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
  }

  const malformed = await f.app.request(`/api/profiles/${user.player_id}/photo`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'multipart/form-data; boundary=broken' },
    body: 'broken',
  });

  assert.equal(malformed.status, 400);
  assert.deepEqual(readFileSync(resolve(f.profiles.folder(user.player_id), 'avatarLarge.jpg')), jpeg);
});

await test('profile zero is a nonfatal 400 and entitlement remains public with the complete route stack', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Zero Rider', '', true);
  const headers = { Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}` };

  for (const path of ['/api/profiles/0', '/api/profiles/0/in-game-fields']) {
    const response = await f.app.request(path, { method: 'PUT', headers, body: new Uint8Array() });
    assert.equal(response.status, 400);
    const me = await f.app.request('/api/profiles/me', { headers });
    assert.equal(me.status, 200);
  }

  for (const input of [{}, headers]) {
    const response = await f.app.request('/api/private_event/entitlement', { headers: input });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { entitled: true });
  }

  const missing = await f.app.request('/api/private_event/nonnumeric', { headers });
  assert.equal(missing.status, 404);
});

await test('saved-game achievements and portal thresholds survive repeated reads and backfill imported routes', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Badge Rider', '', true);
  const other = await f.accounts.create('Other Rider', '');
  const headers = { Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}` };
  const saved = new Uint8Array(0x1_51);
  saved[0x1_08] = 2;
  saved[0x1_10 + 7] = 8; // badge 59, mapped to a route in the bundled dictionary
  saved[0x1_10 + 8] = 1;
  f.profiles.save(
    user.player_id,
    create(PlayerProfileSchema, { id: BigInt(user.player_id), firstName: 'Badge', savedGame: saved }),
  );
  const insert = f.accounts.db.prepare('INSERT INTO route_result(player_id,route_hash) VALUES (?,10001)');
  insert.run(other.player_id);

  for (let count = 0; count <= 25; count++) {
    if (count) insert.run(user.player_id);

    if (![0, 1, 9, 10, 24, 25].includes(count)) continue;
    const response = await f.app.request('/api/achievement/loadPlayerAchievements', { headers });

    const ids = fromBinary(AchievementsSchema, new Uint8Array(await response.arrayBuffer())).achievements.map(
      (item) => item.id,
    );

    assert.ok(ids.includes(59) && ids.includes(64));

    for (const [minimum, badge] of [
      [1, 211],
      [10, 212],
      [25, 213],
    ] as const)
      assert.equal(ids.includes(badge), count >= minimum);
    assert.equal(ids.length, new Set(ids).size);
  }

  for (let request = 0; request < 2; request++) {
    const response = await f.app.request('/api/route-results/completion-stats/all?page=0&pageSize=100', { headers });

    const stats = z
      .object({
        response: z.object({ stats: z.array(z.object({ routeHash: z.number(), firstCompletedAt: z.string() })) }),
      })
      .parse(await response.json()).response.stats;

    assert.deepEqual(
      stats.find((item) => item.routeHash === 3_114_603_308),
      { routeHash: 3_114_603_308, firstCompletedAt: '' },
    );
  }

  assert.equal(
    f.accounts.db
      .prepare('SELECT count(*) AS n FROM route_result WHERE player_id=? AND route_hash=3114603308')
      .get(user.player_id)?.n,
    1,
  );
});

await test('activity list applies the legacy SQL month cutoff without deleting history', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('History Rider', '', true);

  const cutoff = z
    .object({ cutoff: z.string() })
    .parse(f.accounts.db.prepare("SELECT date('now','-1 month') AS cutoff").get()).cutoff;

  const insert = f.accounts.db.prepare(
    "INSERT INTO activity(player_id,date,name,distanceInMeters,course_id,start_date) VALUES (?,?,?,100,6,'2026-01-01T00:00:00Z')",
  );

  insert.run(user.player_id, '2000-01-01', 'old');
  insert.run(user.player_id, cutoff, 'boundary');
  insert.run(user.player_id, `${cutoff}T00:00:01Z`, 'included');
  const headers = { Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}` };
  const response = await f.app.request(`/api/profiles/${user.player_id}/activities`, { headers });
  assert.deepEqual(
    fromBinary(ActivityListSchema, new Uint8Array(await response.arrayBuffer())).activities.map((item) => item.name),
    ['included'],
  );
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM activity').get()?.n, 3);
  const old = await f.app.request('/api/activities/1', { headers });
  assert.equal(old.status, 200);
});

await test('meetup creation announces organizer join and editing resets existing invitation notifications', async (t) => {
  const f = runtimeFixture(t);
  const owner = await f.accounts.create('Organizer', '', true);
  const invited = await f.accounts.create('Invitee', '');

  const headers = {
    Authorization: `Bearer ${f.sessions.tokens(owner, f.tokens).access_token}`,
    'Content-Type': 'application/json',
  };

  f.world.online.set(BigInt(invited.player_id), create(PlayerStateSchema, { id: BigInt(invited.player_id) }));

  const event = {
    culling: true,
    distanceInMeters: 100,
    durationInSeconds: 0,
    eventStart: '2026-11-13T12:00:00Z',
    invitedProfileIds: [invited.player_id],
    laps: 1,
    routeId: 123,
    rubberbanding: true,
    showResults: true,
    sport: 'CYCLING',
    workoutHash: 0,
  };

  const response = await f.app.request('/api/private_event', { method: 'POST', headers, body: JSON.stringify(event) });
  assert.equal(response.status, 201);
  const { id } = z.object({ id: z.number() }).parse(await response.json());

  for (const rider of [owner, invited]) {
    const update = f.world.updates.get(BigInt(rider.player_id))?.find((item) => item.waType === WA_TYPE.WAT_JOIN_E);
    assert.ok(update);
    const decoded = fromBinary(PlayerJoinedEventSchema, update.payload);
    assert.equal(decoded.playerId, BigInt(owner.player_id));
    assert.equal(decoded.relId, BigInt(id));
  }

  f.accounts.db
    .prepare('UPDATE notification SET json=?')
    .run(JSON.stringify({ read: true, readDate: 'old', lastModified: 'old' }));

  const edited = await f.app.request(`/api/private_event/${id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ ...event, description: 'changed' }),
  });

  assert.equal(edited.status, 200);
  const row = f.accounts.db.prepare('SELECT json FROM notification').get();

  const notification = z
    .object({ read: z.boolean(), readDate: z.null(), lastModified: z.string() })
    .parse(JSON.parse(z.string().parse(row?.json)));

  assert.equal(notification.read, false);
  assert.notEqual(notification.lastModified, 'old');
});

await test('race summary derives meetup durations and avatars without changing submitted data', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Racer', '', true);
  const headers = { Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}` };
  writeDurable(resolve(f.profiles.folder(user.player_id), 'avatarLarge.jpg'), Buffer.from('avatar'));
  f.accounts.db
    .prepare('INSERT INTO private_event(id,json) VALUES (42,?)')
    .run(JSON.stringify({ eventStart: '2026-11-13T12:00:00Z' }));
  const worldTime = BigInt(Date.parse('2026-11-13T12:01:00Z')) - 1_414_016_074_397n;

  const response = await f.app.request('/api/race-results', {
    method: 'POST',
    headers,
    body: toBinary(
      RaceResultEntrySaveRequestSchema,
      create(RaceResultEntrySaveRequestSchema, { eventSubgroupId: 42n, activityData: { worldTime, elapsedMs: 5n } }),
    ),
  });

  assert.equal(response.status, 202);

  for (const expected of [60_000n, 60_000n]) {
    const summary = await f.app.request('/api/race-results/summary?event_subgroup_id=42', { headers });
    const decoded = fromBinary(RaceResultSummarySchema, new Uint8Array(await summary.arrayBuffer()));
    assert.equal(decoded.f1[0]?.activityData?.elapsedMs, expected);
    assert.match(decoded.f1[0]?.profileData?.avatarUrl ?? '', /avatarLarge.jpg$/);
    assert.deepEqual(decoded.f1, decoded.f2);
  }

  f.accounts.db.prepare('DELETE FROM private_event WHERE id=42').run();
  const summary = await f.app.request('/api/race-results/summary?event_subgroup_id=42', { headers });
  assert.equal(
    fromBinary(RaceResultSummarySchema, new Uint8Array(await summary.arrayBuffer())).f1[0]?.activityData?.elapsedMs,
    5n,
  );
});

await test('profile JSON edits reuse read negotiation and avatar resolution', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Profile Rider', '', true);

  const headers = {
    Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}`,
    'Content-Type': 'application/json',
  };

  writeDurable(resolve(f.profiles.folder(user.player_id), 'avatarLarge.jpg'), Buffer.from('avatar'));

  const json = await f.app.request(`/api/profiles/me/${user.player_id}`, {
    method: 'PUT',
    headers: { ...headers, Accept: 'application/json' },
    body: JSON.stringify({ firstName: 'Changed' }),
  });

  assert.equal(json.status, 200);
  const profile = z.object({ firstName: z.string(), imageSrc: z.string() }).parse(await json.json());
  assert.equal(profile.firstName, 'Changed');
  assert.match(profile.imageSrc, /avatarLarge.jpg$/);

  const binary = await f.app.request(`/api/profiles/me/${user.player_id}`, {
    method: 'PUT',
    headers: { ...headers, Accept: 'application/x-protobuf-lite' },
    body: JSON.stringify({ lastName: 'Name' }),
  });

  assert.equal(binary.status, 200);
  assert.equal(fromBinary(PlayerProfileSchema, new Uint8Array(await binary.arrayBuffer())).lastName, 'Name');
  const missing = await f.app.request('/api/profiles/999999', { headers });
  assert.equal(missing.status, 404);
});
