import { ImportsService } from '#src/services/profile-import.service';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mediumFixture, binary, decode } from '#tests/medium/support';
import { ZFileProtoSchema, ZFilesProtoSchema } from '#src/protocol/generated/zfiles_pb';
import { AchievementsSchema, PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import { UserStorageSchema } from '#src/protocol/generated/user_storage_pb';
import { RouteResultSaveRequestSchema } from '#src/protocol/generated/route-result_pb';
import { createCdn } from '#src/node/network/cdn';
import { WorkoutsService } from '#src/services/workout.service';
import { writeDurable } from '#src/repositories/files.repository';

for (const companion of [false, true])
  for (const json of [false, true]) {
    await test(`F01 zfile lifecycle: Companion=${companion}, JSON response=${json}`, async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 13, 12) });
      const f = await mediumFixture(t);
      const path = resolve(f.profiles.folder(f.rider.player_id), 'customworkouts', 'tempo.zwo');

      const upload = (content: string) =>
        f.request('/api/zfiles', {
          method: 'POST',
          ...(companion
            ? {
                body: JSON.stringify({
                  folder: 'customworkouts',
                  name: 'tempo.zwo',
                  content: Buffer.from(content).toString('base64'),
                }),
                headers: {
                  Source: 'zwift-companion',
                  'Content-Type': 'application/json',
                  Accept: json ? 'application/json' : '*/*',
                },
              }
            : {
                ...binary(ZFileProtoSchema, {
                  folder: 'customworkouts',
                  filename: 'tempo.zwo',
                  file: Buffer.from(content),
                }),
                headers: { Accept: json ? 'application/json' : '*/*' },
              }),
        });

      const first = await upload('first');
      assert.equal(first.status, 200);

      const metadata = json
        ? z.looseObject({ id: z.number(), lastModified: z.string() }).parse(await first.json())
        : await decode(first, ZFileProtoSchema);

      assert.ok(metadata.id);
      assert.equal(readFileSync(path, 'utf8'), 'first');
      t.mock.timers.tick(5000);
      const second = await upload('replacement');
      const updated = json ? await second.json() : await decode(second, ZFileProtoSchema);
      assert.equal(String(updated.id), String(metadata.id));

      if (json)
        assert.equal(
          updated.lastModified,
          new Date(Date.UTC(2026, 10, 13, 12, 0, 5)).toISOString().replace('Z', '+0000'),
        );
      else assert.equal(updated.timestamp, BigInt(Date.UTC(2026, 10, 13, 12, 0, 5) / 1000));
      const listed = await decode(await f.request('/api/zfiles/list?folder=customworkouts'), ZFilesProtoSchema);
      assert.equal(listed.zfiles.length, 1);
      assert.equal(listed.zfiles[0]?.timestamp, BigInt(Date.UTC(2026, 10, 13, 12, 0, 5) / 1000));
      assert.equal(String(listed.zfiles[0]?.id), String(metadata.id));

      for (const suffix of ['', '/download']) {
        const response1 = await f.request(`/api/zfiles/${metadata.id}${suffix}`);
        assert.equal(await response1.text(), 'replacement');
        const response2 = await f.request(`/api/zfiles/${metadata.id}${suffix}`, {}, f.other);
        assert.equal(response2.status, 404);
      }

      const response3 = await f.request(`/api/zfiles/${metadata.id}`, { method: 'DELETE' }, f.other);
      assert.equal(response3.status, 404);
      const response4 = await f.request(`/api/zfiles/${metadata.id}`, { method: 'DELETE' });
      assert.equal(response4.status, 200);
      assert.equal(existsSync(path), false);
      const response5 = await f.request(`/api/zfiles/${metadata.id}/download`);
      assert.equal(response5.status, 404);
      assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM zfile').get()?.n, 0);
    });
  }

await test('F01 invalid base64 and unsafe filenames cannot create files or metadata', async (t) => {
  const f = await mediumFixture(t);

  for (const [name, content] of [
    ['bad.zwo', '!invalid!'],
    ['../escape', 'dGVzdA=='],
  ]) {
    const response = await f.request('/api/zfiles', {
      method: 'POST',
      headers: { Source: 'zwift-companion', 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: 'customworkouts', name, content }),
    });

    assert.equal(response.status, 400);
  }

  const malformed = await f.request('/api/zfiles', {
    method: 'POST',
    headers: { Source: 'zwift-companion', 'Content-Type': 'application/json' },
    body: '{',
  });

  assert.equal(malformed.status, 400);

  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM zfile').get()?.n, 0);
});

{
  await test('F02 avatar multipart/raw upload preserves image bytes and rejects cross-rider replacement', async (t) => {
    const f = await mediumFixture(t);
    const image = new Uint8Array([255, 216, 255, 224, 0, 2, 255, 217]);
    const upload = `/api/profiles/${f.rider.player_id}/photo`;
    const download = `/download/${f.rider.player_id}/avatarLarge.jpg`;

    for (const multipart of [true, false]) {
      const form = new FormData();
      form.set('photo', new File([image], 'avatar.jpg', { type: 'image/jpeg' }));
      const response6 = await f.request(upload, { method: 'POST', body: multipart ? form : image });
      assert.equal(response6.status, 200);
      const response = await f.app.request(download);
      assert.equal(response.headers.get('Content-Type'), 'image/jpeg');
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), image);
    }

    const response7 = await f.request(upload, {
      method: 'POST',
      body: 'broken',
      headers: { 'Content-Type': 'multipart/form-data; boundary=broken' },
    });

    assert.equal(response7.status, 400);
    const response8 = await f.request(upload, { method: 'POST', body: image }, f.other);
    assert.equal(response8.status, 401);
    const response9 = await f.request(download);
    assert.deepEqual(new Uint8Array(await response9.arrayBuffer()), image);
  });
}

{
  await test('F03 profile zero returns 400 without invalidating the token; replacement clears omitted fields', async (t) => {
    const f = await mediumFixture(t);

    for (const suffix of ['', '/in-game-fields']) {
      const response10 = await f.request(`/api/profiles/0${suffix}`, {
        method: 'PUT',
        ...binary(PlayerProfileSchema, {}),
      });

      assert.equal(response10.status, 400);

      const response11 = await f.request(`/api/profiles/${f.other.player_id}${suffix}`, {
        method: 'PUT',
        ...binary(PlayerProfileSchema, {}),
      });

      assert.equal(response11.status, 401);

      const response12 = await f.request(`/api/profiles/${f.rider.player_id}${suffix}`, {
        method: 'PUT',
        ...binary(PlayerProfileSchema, { totalRunDistance: 12_345 }),
      });

      assert.equal(response12.status, 204);
      assert.equal(f.profiles.get(f.rider.player_id).totalRunDistance, 12_345);

      const response13 = await f.request(`/api/profiles/${f.rider.player_id}${suffix}`, {
        method: 'PUT',
        ...binary(PlayerProfileSchema, {}),
      });

      assert.equal(response13.status, 204);
      assert.equal(f.profiles.get(f.rider.player_id).totalRunDistance, 0);
      const response14 = await decode(await f.request('/api/profiles/me'), PlayerProfileSchema);
      assert.equal(response14.id, BigInt(f.rider.player_id));
    }
  });
}

for (const count of [0, 1, 9, 10, 24, 25]) {
  await test(`F04 portal badges derive at threshold ${count} and persist idempotently`, async (t) => {
    const f = await mediumFixture(t);
    const profile = f.profiles.get(f.rider.player_id);
    profile.savedGame = new Uint8Array(337);
    profile.savedGame[264] = 2;
    profile.savedGame[272] = 128;
    profile.savedGame[273] = 1;
    f.profiles.save(f.rider.player_id, profile);

    for (let i = 0; i < count; i++) {
      const response15 = await f.request('/api/route-results', {
        method: 'POST',
        ...binary(RouteResultSaveRequestSchema, { routeHash: 10_001n }),
      });

      assert.equal(response15.status, 202);
    }

    await f.request(
      '/api/route-results',
      { method: 'POST', ...binary(RouteResultSaveRequestSchema, { routeHash: 10_001n }) },
      f.other,
    );

    const expected = [7, 8, ...(count >= 1 ? [211] : []), ...(count >= 10 ? [212] : []), ...(count >= 25 ? [213] : [])];

    for (let i = 0; i < 2; i++) {
      const result = await decode(await f.request('/api/achievement/loadPlayerAchievements'), AchievementsSchema);
      assert.deepEqual(
        result.achievements.map((a) => a.id),
        expected,
      );
    }

    assert.ok(existsSync(resolve(f.profiles.folder(f.rider.player_id), 'achievements.bin')));
  });
}

{
  await test('achievement unlock and multi-field game storage survive repeated reads without duplicates', async (t) => {
    const f = await mediumFixture(t);

    for (let i = 0; i < 2; i++) {
      const response16 = await f.request('/api/achievement/unlock', {
        method: 'POST',
        ...binary(AchievementsSchema, { achievements: [{ id: 42 }] }),
      });

      assert.equal(response16.status, 202);
    }

    const response17 = await decode(await f.request('/api/achievement/loadPlayerAchievements'), AchievementsSchema);
    assert.deepEqual(
      response17.achievements.map((a) => a.id),
      [42],
    );

    for (const signature of ['frame-1', 'frame-2']) {
      const response18 = await f.request('/api/player-profile/user-game-storage/attributes', {
        method: 'POST',
        ...binary(UserStorageSchema, {
          attributes: [{ bikeProgress: { signature, level: 3 }, gameSettings: { minimalLeaderboards: 1 } }],
        }),
      });

      assert.equal(response18.status, 202);
    }

    const storage = await decode(
      await f.request('/api/player-profile/user-game-storage/attributes?n=24&n=24&n=22'),
      UserStorageSchema,
    );

    // The filter uses protobuf field numbers, not array positions.
    assert.equal(storage.attributes.length, 2);
    assert.deepEqual(
      storage.attributes.map((a) => a.bikeProgress?.signature),
      ['frame-1', 'frame-2'],
    );
    assert.equal(storage.attributes.filter((a) => a.gameSettings).length, 1);

    const outsider = await decode(
      await f.request('/api/player-profile/user-game-storage/attributes?n=24', {}, f.other),
      UserStorageSchema,
    );

    assert.equal(outsider.attributes.length, 0);
  });
}

await test('CDN workout endpoint serves exactly the cached XML', async (t) => {
  const f = await mediumFixture(t);
  const id = '84e16aa6-2e13-4cc5-9bea-76595a66abe0';
  const file = new WorkoutsService(f).file(id);
  assert.ok(file);
  writeDurable(file, '<workout_file><name>Tempo</name></workout_file>');
  const response = await createCdn(f).request(`/tp-workouts/intervalsicu/${id}.zwo`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/xml');
  assert.equal(await response.text(), readFileSync(file, 'utf8'));
});

await test('zfile uploads cannot create internal import journals through either upload format', async (t) => {
  const f = await mediumFixture(t);

  for (const folder of ['.import-review', `.ts-import-${'a'.repeat(32)}`, '.hidden'])
    for (const companion of [false, true]) {
      const response = await f.request('/api/zfiles', {
        method: 'POST',
        ...(companion
          ? {
              headers: { Source: 'zwift-companion', 'Content-Type': 'application/json' },
              body: JSON.stringify({ folder, name: 'manifest.json', content: 'e30=' }),
            }
          : binary(ZFileProtoSchema, { folder, filename: 'manifest.json', file: Buffer.from('{}') })),
      });

      assert.equal(response.status, 400);
      assert.equal(existsSync(resolve(f.profiles.folder(f.rider.player_id), folder)), false);
    }

  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM zfile').get()?.n, 0);
  assert.doesNotThrow(() => new ImportsService(f.accounts, f.world).recover());
});
