import { storedSchema, type MeetupInput } from '#src/dtos/meetup.dto';
import {
  PlayerJoinedEventSchema,
  PrivateEventFeedListProtoSchema,
  PrivateEventProtoSchema,
} from '#src/protocol/generated/events_pb';
import { AchievementsSchema } from '#src/protocol/generated/profile_pb';
import { RaceResultEntrySaveRequestSchema, RaceResultSummarySchema } from '#src/protocol/generated/race-result_pb';
import {
  SegmentResultSchema,
  SegmentResultsSchema,
  SegmentRideStatsSchema,
} from '#src/protocol/generated/segment-result_pb';
import { WA_TYPE } from '#src/protocol/generated/udp-node-msgs_pb';
import { worldTime } from '#src/world/state';
import { binary, decode, mediumFixture } from '#tests/medium/support';
import { fromBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';

const jsonRequest = (body: MeetupInput) => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

await test('meetup rescheduling reconciles expired, retained, removed and newly added invitations', async (t) => {
  const f = await mediumFixture(t);
  const retained = await f.accounts.create('Retained Rider', '');
  const added = await f.accounts.create('Added Rider', '');

  const input: MeetupInput = {
    description: '',
    culling: false,
    distanceInMeters: 10_000,
    durationInSeconds: 0,
    eventStart: new Date(Date.now() - 3_600_000).toISOString(),
    invitedProfileIds: [f.other.player_id, retained.player_id, retained.player_id, f.rider.player_id],
    laps: 1,
    routeId: 123,
    rubberbanding: true,
    showResults: true,
    sport: 'CYCLING',
    workoutHash: 0,
  };

  const created = await f.request('/api/private_event', { method: 'POST', ...jsonRequest(input) });
  assert.equal(created.status, 201);
  const { id } = z.object({ id: z.number() }).parse(await created.json());
  const path = `/api/private_event/${id}`;

  const counts = async (accepted: number) => {
    const response = await f.request(path, { headers: { Accept: 'application/json' } });
    assert.equal(response.status, 200);
    const event = storedSchema.parse(await response.json());
    assert.equal(event.acceptedTotalCount, accepted);
    assert.equal(event.acceptedFolloweeCount, accepted - 1);
    assert.equal(event.invitedTotalCount, 3);
  };

  await counts(1);
  const expired = await f.request('/api/notifications', {}, retained);
  assert.deepEqual(await expired.json(), []);

  for (let i = 0; i < 2; i++) {
    const accepted = await f.request(`${path}/accept`, { method: 'PUT' }, retained);
    assert.equal(accepted.status, 204);
  }

  await counts(2);
  const eventStart = new Date(Date.now() + 3_600_000).toISOString();

  const updated = await f.request(path, {
    method: 'PUT',
    ...jsonRequest({ ...input, eventStart, invitedProfileIds: [retained.player_id, added.player_id] }),
  });

  assert.equal(updated.status, 200);
  await counts(2);
  const removed = await f.request('/api/notifications', {}, f.other);
  assert.deepEqual(await removed.json(), []);
  assert.equal(f.services.events.notificationsForPlayer(f.other.player_id).length, 0);

  for (const rider of [retained, added]) {
    const notifications = await f.request('/api/notifications', {}, rider);
    const entries = z.array(z.string()).parse(await notifications.json());
    assert.equal(entries.length, 1);
    const notification = z.object({ read: z.boolean(), argString0: z.string() }).parse(JSON.parse(entries[0]!));
    assert.equal(notification.read, false);
    assert.deepEqual(JSON.parse(notification.argString0), {
      eventId: id,
      eventStartDate: Math.trunc(Date.parse(eventStart) / 1000),
      otherInviteeCount: 2,
    });
  }

  const rejected = await f.request(`${path}/reject`, { method: 'PUT' }, retained);
  assert.equal(rejected.status, 204);
  await counts(1);
  const feed = await decode(await f.request('/api/private_event/feed'), PrivateEventFeedListProtoSchema);
  assert.equal(feed.pef[0]?.acceptedTotalCount, 1);
  assert.equal(feed.pef[0]?.acceptedFolloweeCount, 0);
  assert.equal(feed.pef[0]?.invitedTotalCount, 3);
});

{
  await test('F06/F09/F10 meetups persist invitations, reset notifications, broadcast signup and summarize race time', async (t) => {
    const f = await mediumFixture(t);
    const outsider = await f.accounts.create('Outsider Rider', '');

    const input = {
      culling: true,
      distanceInMeters: 10_000,
      durationInSeconds: 0,
      eventStart: new Date(Date.now() + 120_000).toISOString(),
      invitedProfileIds: [f.other.player_id],
      laps: 1,
      routeId: 123,
      rubberbanding: true,
      showResults: true,
      sport: 'CYCLING',
      workoutHash: 0,
    };

    const json = (value: typeof input | { read: boolean; readDate: string }) => ({
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });

    const response = await f.request('/api/private_event', { method: 'POST', ...json(input) });
    assert.equal(response.status, 201);
    const { id } = z.object({ id: z.number() }).parse(await response.json());
    const base = `/api/private_event/${id}`;
    const event = await decode(await f.request(base, {}, f.other), PrivateEventProtoSchema);
    assert.equal(event.organizerId, BigInt(f.rider.player_id));
    assert.equal(event.eventInvites.length, 2);
    const joined = f.world.updates.get(BigInt(f.rider.player_id))?.find((a) => a.waType === WA_TYPE.WAT_JOIN_E);
    assert.ok(joined);
    assert.equal(fromBinary(PlayerJoinedEventSchema, joined.payload).playerId, BigInt(f.rider.player_id));
    const response1 = await f.request(base, { method: 'DELETE' }, outsider);
    assert.equal(response1.status, 403);

    for (const decision of ['reject', 'accept']) {
      const response2 = await f.request(`${base}/${decision}`, { method: 'PUT' }, f.other);
      assert.equal(response2.status, 204);
    }

    const feed = await f.request('/api/private_event/feed', { headers: { Accept: 'application/json' } }, f.other);
    assert.equal(z.array(z.object({ inviteStatus: z.string() })).parse(await feed.json())[0]?.inviteStatus, 'ACCEPTED');
    const response3 = await f.request('/api/notifications', {}, f.other);
    const notifications = z.array(z.string()).parse(await response3.json());
    assert.equal(notifications.length, 1);
    const notification = z.object({ id: z.number() }).parse(JSON.parse(notifications[0]!));

    const response4 = await f.request(
      `/api/notifications/${notification.id}`,
      { method: 'PUT', ...json({ read: true, readDate: new Date().toISOString() }) },
      f.other,
    );

    assert.equal(response4.status, 204);
    const response5 = await f.request(base, { method: 'PUT', ...json({ ...input, distanceInMeters: 20_000 }) });
    assert.equal(response5.status, 200);
    const response6 = await f.request('/api/notifications', {}, f.other);
    const reset = z.array(z.string()).parse(await response6.json());
    assert.equal(z.object({ read: z.boolean() }).parse(JSON.parse(reset[0]!)).read, false);
    assert.equal(z.object({ readDate: z.union([z.string(), z.null()]) }).parse(JSON.parse(reset[0]!)).readDate, null);
    const finish = BigInt(Date.parse(input.eventStart) + 90_000) - 1_414_016_074_397n;

    const response7 = await f.request('/api/race-results', {
      method: 'POST',
      ...binary(RaceResultEntrySaveRequestSchema, {
        eventSubgroupId: BigInt(id),
        activityData: { worldTime: finish, elapsedMs: 1n },
      }),
    });

    assert.equal(response7.status, 202);

    const race = await decode(
      await f.request(`/api/race-results/summary?event_subgroup_id=${id}`),
      RaceResultSummarySchema,
    );

    assert.equal(race.f1[0]?.activityData?.elapsedMs, 90_000n);
    assert.equal(race.f1[0]?.playerId, BigInt(f.rider.player_id));
    const response8 = await f.request(base, { method: 'DELETE' });
    assert.equal(response8.status, 200);
    const response9 = await f.request(base);
    assert.equal(response9.status, 404);
    const response10 = await f.request('/api/notifications', {}, f.other);
    assert.deepEqual(await response10.json(), []);

    for (const headers of [{}, f.headers()]) {
      const response11 = await f.app.request('/api/private_event/entitlement', { headers });
      assert.deepEqual(await response11.json(), {
        entitled: true,
      });
    }
  });
}

{
  await test('segment records flow through personal summaries, quarterly queries and public leaderboards', async (t) => {
    const f = await mediumFixture(t);

    for (const elapsedMs of [1000n, 2000n]) {
      const response12 = await f.request('/api/segment-results', {
        method: 'POST',
        ...binary(SegmentResultSchema, {
          playerId: BigInt(f.other.player_id),
          segmentId: 42n,
          firstName: 'M',
          lastName: 'Rider',
          elapsedMs,
        }),
      });

      assert.equal(response12.status, 200);
    }

    const stats = await decode(
      await f.request('/api/personal-records/my-segment-ride-stats/CYCLING?segmentId=42'),
      SegmentRideStatsSchema,
    );

    assert.equal(stats.bestTime, 1000n);
    assert.equal(stats.latestTime, 2000n);

    const records = await decode(
      await f.request('/api/personal-records/my-records?segmentId=42'),
      SegmentResultsSchema,
    );

    assert.equal(records.segmentResults.length, 2);

    for (const path of ['/live-segment-results-service/leaders', '/live-segment-results-service/leaderboard/42']) {
      const leaders = await decode(await f.app.request(path), SegmentResultsSchema);
      assert.equal(leaders.segmentResults.length, 1);
      assert.equal(leaders.segmentResults[0]?.playerId, BigInt(f.rider.player_id));
      assert.equal(leaders.segmentResults[0]?.elapsedMs, 1000n);
    }

    const date = new Date();

    for (const path of [
      '?segmentIds=42',
      '/segments/42/by-quarter',
      `/segments/42/date/${date.getUTCFullYear()}/Q${Math.floor(date.getUTCMonth() / 3) + 1}/all`,
    ]) {
      const response = await f.request(`/api/personal-records/results/summary/profiles/me/CYCLING${path}`);
      assert.equal(response.status, 200);
      assert.ok(z.object({ results: z.array(z.unknown()) }).parse(await response.json()).results.length > 0);
    }
  });
}

{
  await test('F05 imported route badges backfill once, preserving real completions and rider isolation', async (t) => {
    const f = await mediumFixture(t);

    const dictionary = z
      .object({ achievements: z.record(z.string(), z.number()) })
      .parse(JSON.parse(readFileSync(resolve(f.assets, 'data/game_dictionary.txt'), 'utf8')));

    const [badge, hash] = Object.entries(dictionary.achievements)[0]!;

    const response13 = await f.request('/api/achievement/unlock', {
      method: 'POST',
      ...binary(AchievementsSchema, { achievements: [{ id: Number(badge) }] }),
    });

    assert.equal(response13.status, 202);

    for (let i = 0; i < 2; i++) {
      const response14 = await f.request('/api/route-results/completion-stats/all');

      const stats = z
        .object({
          response: z.object({ stats: z.array(z.object({ routeHash: z.number(), firstCompletedAt: z.string() })) }),
        })
        .parse(await response14.json());

      assert.ok(stats.response.stats.some((s) => s.routeHash === hash && s.firstCompletedAt === ''));
    }

    assert.equal(
      f.accounts.db.prepare('SELECT count(*) AS n FROM route_result WHERE player_id=?').get(f.rider.player_id)?.n,
      1,
    );
    f.accounts.db
      .prepare('INSERT INTO route_result (player_id,route_hash,world_time) VALUES (?,?,?)')
      .run(f.rider.player_id, hash, Number(worldTime()));
    const response15 = await f.request('/api/route-results/completion-stats/all');

    const real = z
      .object({ response: z.object({ stats: z.array(z.object({ firstCompletedAt: z.string() })) }) })
      .parse(await response15.json());

    assert.ok(real.response.stats[0]?.firstCompletedAt);
    const response16 = await f.request('/api/route-results/completion-stats/all', {}, f.other);
    const other = z.object({ response: z.object({ stats: z.array(z.unknown()) }) }).parse(await response16.json());
    assert.deepEqual(other.response.stats, []);
  });
}
