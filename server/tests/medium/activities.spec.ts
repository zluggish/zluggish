import {
  FitnessPrivacy,
  ActivitySchema,
  ActivityListSchema,
  ActivityImageSchema,
  ActivityMediaSaveRequestSchema,
  ActivityMediaSaveResultSchema,
} from '#src/protocol/generated/activity_pb';
import { ActivityPrivacyType } from '#src/protocol/generated/profile_pb';
import { writeDurable } from '#src/repositories/files.repository';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mediumFixture, binary, decode } from '#tests/medium/support';
import { GoalSchema, GoalsSchema } from '#src/protocol/generated/goal_pb';
import { FitnessSchema } from '#src/protocol/generated/fitness_pb';

{
  await test('activity create, feeds, details, update, images, signed media and owner-only delete', async (t) => {
    const f = await mediumFixture(t);
    const base = `/api/profiles/${f.rider.player_id}/activities`;

    const data = {
      courseId: 6n,
      playerId: BigInt(f.other.player_id),
      name: 'Morning ride',
      distanceInMeters: 12_345,
      startDate: new Date(Date.now() - 600_000).toISOString(),
      endDate: new Date().toISOString(),
      sport: 0,
    };

    const response = await f.request(base, { method: 'POST', ...binary(ActivitySchema, data) });
    assert.equal(response.status, 200);
    const { id } = z.object({ id: z.number() }).parse(await response.json());
    const saved = await decode(await f.request(base), ActivityListSchema);
    assert.equal(saved.activities[0]?.playerId, BigInt(f.rider.player_id));
    assert.equal(saved.activities[0]?.name, data.name);

    for (const path of [
      '/api/activity-feed/feed/?feedType=JUST_ME',
      '/api/activity-feed-service-v2/feed/just-me',
      `/api/activity-feed-service-v2/feed/profile/${f.rider.player_id}`,
    ]) {
      const feed = await f.request(path);
      assert.equal(feed.status, 200);
      assert.equal(z.array(z.object({ id: z.number() })).parse(await feed.json())[0]?.id, id);
    }

    const detail = await f.request(`/api/activities/${id}`);
    assert.equal(z.object({ distanceInMeters: z.number() }).parse(await detail.json()).distanceInMeters, 12_345);

    const response1 = await f.request(`${base}/${id}`, {
      method: 'PUT',
      ...binary(ActivitySchema, { ...data, id: BigInt(id), name: 'Updated' }),
    });

    assert.equal(response1.status, 200);
    const response2 = await decode(await f.request(base), ActivityListSchema);
    assert.equal(response2.activities[0]?.name, 'Updated');
    const jpeg = new Uint8Array([255, 216, 255, 217]);

    const image = await f.request(`${base}/${id}/images`, {
      method: 'POST',
      ...binary(ActivityImageSchema, { activityId: BigInt(id), jpg: jpeg }),
    });

    assert.equal(image.status, 200);
    const imageId = z.object({ id: z.number() }).parse(await image.json()).id;
    assert.deepEqual(
      readFileSync(resolve(f.profiles.folder(f.rider.player_id), 'images', `${imageId}.jpg`)),
      Buffer.from(jpeg),
    );

    const media = await decode(
      await f.request(`${base}/${id}/medias`, {
        method: 'POST',
        ...binary(ActivityMediaSaveRequestSchema, { contentType: 'video/mp4' }),
      }),
      ActivityMediaSaveResultSchema,
    );

    const url = new URL(media.uploadUrl);
    const response3 = await f.app.request(url.pathname, { method: 'PUT', body: 'video' });
    assert.equal(response3.status, 403);
    const response4 = await f.app.request(url.pathname + url.search, { method: 'PUT', body: 'video' });
    assert.equal(response4.status, 200);
    const response5 = await f.app.request(url.pathname + url.search, { method: 'PUT', body: 'replay' });
    assert.equal(response5.status, 403);
    assert.equal(
      readFileSync(
        resolve(f.profiles.folder(f.rider.player_id), 'medias', `${url.pathname.split('/').at(-1)}.mp4`),
        'utf8',
      ),
      'video',
    );
    const response6 = await f.request(`${base}/${id}`, { method: 'DELETE' }, f.other);
    assert.equal(response6.status, 401);
    const response7 = await f.request(`${base}/${id}`, { method: 'DELETE' });
    assert.equal(response7.status, 200);
    const response8 = await f.request(`/api/activities/${id}`);
    assert.equal(response8.status, 404);
  });
}

{
  await test('F08 goals mirror progress through JSON, protobuf and mobile; update/delete enforce ownership', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 12, 12) });
    const f = await mediumFixture(t);

    const insert = f.accounts.db.prepare(
      'INSERT INTO activity (player_id,sport,start_date,end_date,distanceInMeters,movingTimeInMs) VALUES (?,?,?,?,?,?)',
    );

    insert.run(f.rider.player_id, 0, '2026-11-12T10:00:00Z', '2026-11-12T11:00:00Z', 12_000, 3_600_000);
    insert.run(f.other.player_id, 0, '2026-11-12T10:00:00Z', '2026-11-12T11:00:00Z', 99_999, 3_600_000);
    const base = `/api/profiles/${f.rider.player_id}/goals`;

    for (const type of [0, 1])
      for (const periodicity of [0, 1]) {
        const goal = await decode(
          await f.request(base, {
            method: 'POST',
            ...binary(GoalSchema, { name: 'Target', type, periodicity, sport: 0, targetDistance: 15_000 }),
          }),
          GoalSchema,
        );

        assert.ok(Math.abs(goal.actualDistance - (type === 0 ? 12_000 : 60)) < 0.001);
        assert.equal(goal.actualDuration, goal.actualDistance);
      }

    const goals = await decode(await f.request(base), GoalsSchema);
    assert.equal(goals.goals.length, 4);
    const response9 = await f.request(base, { headers: { Accept: 'application/json' } });

    const json = z
      .array(z.object({ id: z.number(), actualDistanceInMeters: z.number(), actualDurationInMinutes: z.number() }))
      .parse(await response9.json());

    assert.equal(json.length, 4);

    for (const goal of json) assert.equal(goal.actualDurationInMinutes, goal.actualDistanceInMeters);
    const mobile = await f.request('/relay/worlds/1/aggregate/mobile?goalCount=4');
    assert.equal(mobile.status, 200);
    assert.equal(z.object({ goals: z.array(z.unknown()) }).parse(await mobile.json()).goals.length, 4);
    const id = goals.goals[0]!.id;

    const update = {
      profileId: f.rider.player_id,
      sport: 'CYCLING',
      name: 'New target',
      type: 0,
      periodicity: 0,
      targetDistanceInMeters: 25_000,
      targetDurationInMinutes: 0,
    };

    const response10 = await f.request(`${base}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    });

    assert.equal(response10.status, 200);
    const response11 = await f.request(`${base}/${id}`, { method: 'DELETE' }, f.other);
    assert.equal(response11.status, 401);
    const response12 = await f.request(`${base}/${id}`, { method: 'DELETE' });
    assert.equal(response12.status, 200);
    const response13 = await decode(await f.request(base), GoalsSchema);
    assert.equal(response13.goals.length, 3);

    const response14 = await f.request('/api/fitness/fitness-goals/history', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekGoalDistanceKilometers: 250 }),
    });

    assert.equal(response14.status, 204);
    const fitness = await decode(await f.request('/api/fitness/metrics-and-goals'), FitnessSchema);
    assert.equal(fitness.goals?.cycling?.distance, 250_000);
    const other = await decode(await f.request('/api/fitness/metrics-and-goals', {}, f.other), FitnessSchema);
    assert.equal(other.goals?.cycling?.distance, 100_000);
  });
}

await test('F11 activity startup list excludes old dates without losing detail, feed or another rider history', async (t) => {
  const f = await mediumFixture(t);

  const { cutoff } = z
    .object({ cutoff: z.string() })
    .parse(f.accounts.db.prepare("SELECT date('now','-1 month') AS cutoff").get());

  const ids: number[] = [];

  for (const date of ['2000-01-01', cutoff, `${cutoff}T00:00:01Z`]) {
    const response = await f.request(`/api/profiles/${f.rider.player_id}/activities`, {
      method: 'POST',
      ...binary(ActivitySchema, {
        playerId: BigInt(f.rider.player_id),
        courseId: 6n,
        name: date,
        date,
        startDate: `${cutoff}T00:00:00Z`,
        endDate: `${cutoff}T01:00:00Z`,
        distanceInMeters: 1234,
      }),
    });

    assert.equal(response.status, 200);
    ids.push(z.object({ id: z.number() }).parse(await response.json()).id);
  }

  const other = await f.request(
    `/api/profiles/${f.other.player_id}/activities`,
    {
      method: 'POST',
      ...binary(ActivitySchema, {
        playerId: BigInt(f.other.player_id),
        courseId: 6n,
        name: 'Other activity',
        date: new Date().toISOString(),
        startDate: `${cutoff}T00:00:00Z`,
        endDate: `${cutoff}T01:00:00Z`,
        distanceInMeters: 9999,
      }),
    },
    f.other,
  );

  assert.equal(other.status, 200);

  for (const slash of ['', '/']) {
    const list = await decode(
      await f.request(`/api/profiles/${f.rider.player_id}/activities${slash}`),
      ActivityListSchema,
    );

    assert.deepEqual(
      list.activities.map((item) => Number(item.id)),
      [ids[2]],
    );
    assert.equal(list.activities[0]?.fit.length, 0);
  }

  const detail = await f.request(`/api/activities/${ids[0]}`);
  assert.equal(detail.status, 200);
  assert.equal(z.object({ name: z.string() }).parse(await detail.json()).name, '2000-01-01');
  const feed = await f.request('/api/activity-feed-service-v2/feed/just-me');
  const activities = z.array(z.object({ id: z.number() })).parse(await feed.json());
  assert.deepEqual(
    activities.map((item) => item.id).sort((a, b) => a - b),
    ids,
  );
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM activity').get()?.n, 4);
});

await test('private activities stay out of other riders feeds, lists, details and charts', async (t) => {
  const f = await mediumFixture(t);
  const base = `/api/profiles/${f.rider.player_id}/activities`;
  const privateIds: number[] = [];

  for (const values of [
    { privacy: ActivityPrivacyType.PRIVATE },
    { privateActivity: true },
    { privacy: ActivityPrivacyType.FRIENDS },
    { privacy: ActivityPrivacyType.PUBLIC },
  ]) {
    const response = await f.request(base, {
      method: 'POST',
      ...binary(ActivitySchema, {
        ...values,
        playerId: BigInt(f.rider.player_id),
        courseId: 6n,
        name: 'Visibility test',
        startDate: new Date().toISOString(),
        distanceInMeters: 2000,
        endDate: new Date().toISOString(),
      }),
    });

    assert.equal(response.status, 200);
    const { id } = z.object({ id: z.number() }).parse(await response.json());
    privateIds.push(id);

    const chart = f.accounts.db
      .prepare('INSERT INTO activity_file (activity_id,full) VALUES (?,0)')
      .run(id).lastInsertRowid;

    writeDurable(resolve(f.config.storageDir, 'activities', String(chart)), '{"heartRate":[150]}');
    const ownerDetail = await f.request(`/api/activities/${id}`);
    assert.equal(ownerDetail.status, 200);
    const detail = z.object({ privacy: z.string() }).parse(await ownerDetail.json());
    assert.equal(detail.privacy, values.privateActivity ? 'PRIVATE' : ActivityPrivacyType[values.privacy ?? 0]);
    const outsider = await f.request(`/api/activities/${id}`, {}, f.other);
    assert.equal(outsider.status, values.privacy === ActivityPrivacyType.PUBLIC ? 200 : 404);
    const file = `/api/activities/${id}/file/${chart}`;
    const anonymous = await f.app.request(file);
    assert.equal(anonymous.status, 401);
    const ownerChart = await f.request(file);
    assert.equal(ownerChart.status, 200);
    const otherChart = await f.request(file, {}, f.other);
    assert.equal(otherChart.status, values.privacy === ActivityPrivacyType.PUBLIC ? 200 : 404);
  }

  for (const path of [
    '/api/activity-feed-service-v2/feed/everyone?limit=1',
    `/api/activity-feed-service-v2/feed/profile/${f.rider.player_id}`,
  ]) {
    const response = await f.request(path, {}, f.other);
    const feed = z.array(z.object({ id: z.number() })).parse(await response.json());
    assert.deepEqual(
      feed.map((activity) => activity.id),
      [privateIds[3]],
    );
  }

  const ownerList = await decode(await f.request(base), ActivityListSchema);
  assert.equal(ownerList.activities.length, 4);
  const otherList = await decode(await f.request(base, {}, f.other), ActivityListSchema);
  assert.deepEqual(
    otherList.activities.map((activity) => Number(activity.id)),
    [privateIds[3]],
  );
});

for (const discard of [false, true])
  await test(`activity deletion removes dependent data and rejects old chart links: discard=${discard}`, async (t) => {
    const f = await mediumFixture(t);

    const id = f.accounts.db
      .prepare('INSERT INTO activity (player_id,name) VALUES (?,?)')
      .run(f.rider.player_id, 'Delete me').lastInsertRowid;

    const chartId = f.accounts.db
      .prepare('INSERT INTO activity_file (activity_id,full) VALUES (?,0)')
      .run(id).lastInsertRowid;

    const imageId = f.accounts.db
      .prepare('INSERT INTO activity_image (player_id,activity_id) VALUES (?,?)')
      .run(f.rider.player_id, id).lastInsertRowid;

    const mediaId = f.accounts.db
      .prepare('INSERT INTO activity_media (player_id,activity_id,content_type) VALUES (?,?,?)')
      .run(f.rider.player_id, id, 'video/mp4').lastInsertRowid;

    const paths = [
      resolve(f.config.storageDir, 'activities', String(chartId)),
      resolve(f.profiles.folder(f.rider.player_id), 'images', `${imageId}.jpg`),
      resolve(f.profiles.folder(f.rider.player_id), 'medias', `${mediaId}.mp4`),
      resolve(f.profiles.folder(f.rider.player_id), 'fit', `${id} - ride.fit`),
    ];

    for (const path of paths) writeDurable(path, 'data');
    const base = `/api/profiles/${f.rider.player_id}/activities/${id}`;
    const wrongOwner = await f.request(base, { method: 'DELETE' }, f.other);
    assert.equal(wrongOwner.status, 401);
    assert.ok(paths.every((path) => existsSync(path)));

    const deleted = await f.request(
      discard ? `${base}?upload-to-strava=true` : base,
      discard
        ? {
            method: 'PUT',
            ...binary(ActivitySchema, {
              playerId: BigInt(f.rider.player_id),
              courseId: 6n,
              name: 'Discard',
              startDate: new Date().toISOString(),
              distanceInMeters: 0,
            }),
          }
        : { method: 'DELETE' },
    );

    assert.equal(deleted.status, 200);

    for (const path of paths) assert.equal(existsSync(path), false);

    for (const table of ['activity', 'activity_file', 'activity_image', 'activity_media'])
      assert.equal(f.accounts.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0);
    const chart = await f.request(`/api/activities/${id}/file/${chartId}`);
    assert.equal(chart.status, 404);
  });

await test('hidden fitness is redacted in protobuf lists, detail, feeds and charts for another rider', async (t) => {
  const f = await mediumFixture(t);
  const base = `/api/profiles/${f.rider.player_id}/activities`;

  const created = await f.request(base, {
    method: 'POST',
    ...binary(ActivitySchema, {
      playerId: BigInt(f.rider.player_id),
      courseId: 6n,
      name: 'Private sensors',
      startDate: new Date().toISOString(),
      endDate: new Date().toISOString(),
      distanceInMeters: 3000,
      fitnessPrivacy: FitnessPrivacy.HIDE_SENSITIVE_DATA,
      avgHeartRate: 175,
      avgWatts: 250,
      normalizedPower: 260,
      powerZones: [1, 2],
      tss: 99,
      calories: 400,
      avgSpeed: 10,
    }),
  });

  const { id } = z.object({ id: z.number() }).parse(await created.json());
  const other = await decode(await f.request(base, {}, f.other), ActivityListSchema);
  assert.equal(other.activities[0]?.avgHeartRate, 0);
  assert.equal(other.activities[0]?.avgWatts, 0);
  assert.equal(other.activities[0]?.normalizedPower, 0);
  assert.deepEqual(other.activities[0]?.powerZones, []);
  assert.equal(other.activities[0]?.distanceInMeters, 3000);
  const own = await decode(await f.request(base), ActivityListSchema);
  assert.equal(own.activities[0]?.avgHeartRate, 175);
  const detail = await f.request(`/api/activities/${id}`, {}, f.other);
  const json = z.record(z.string(), z.json()).parse(await detail.json());
  assert.equal(json.avgHeartRate, undefined);
  assert.equal(json.avgWatts, undefined);

  for (const path of [
    `/api/activity-feed-service-v2/feed/profile/${f.rider.player_id}`,
    `/api/activity-feed/feed/?feedType=PROFILE&profile_id=${f.rider.player_id}`,
  ]) {
    const response = await f.request(path, {}, f.other);
    assert.equal(response.status, 200);
    const feed = z.array(z.record(z.string(), z.json())).parse(await response.json());
    assert.equal(feed.length, 1);
    assert.equal(feed[0]?.calories, 0);
    assert.equal(feed[0]?.avgSpeedInMetersPerSecond, 0);
    assert.equal(feed[0]?.avgWatts, undefined);
  }

  const chart = await f.request(`/api/activities/${id}/file/1`, {}, f.other);
  assert.equal(chart.status, 404);
});
