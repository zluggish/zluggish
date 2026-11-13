import { parseProtobuf } from '#src/http/protobuf';
import { authenticated } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import type { RaceResultEntrySaveRequest } from '#src/protocol/generated/race-result_pb';
import {
  RaceResultEntryProfileDataSchema,
  RaceResultEntrySaveRequestSchema,
  RaceResultEntrySchema,
  RaceResultSummarySchema,
} from '#src/protocol/generated/race-result_pb';
import {
  LoadPlayerRouteCompletionAchievementsResponseSchema,
  RouteCompletionAchievementUnlockRequestSchema,
} from '#src/protocol/generated/route-completion-achievement_pb';
import { RouteResultSaveRequestSchema } from '#src/protocol/generated/route-result_pb';
import type { SegmentResult } from '#src/protocol/generated/segment-result_pb';
import {
  SegmentResultSchema,
  SegmentResultsSchema,
  SegmentRideStatsSchema,
} from '#src/protocol/generated/segment-result_pb';
import { WA_TYPE, WorldAttributeSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { course, worldTime } from '#src/world/state';
import { clearField, clone, create, fromBinary, fromJsonString, toBinary } from '@bufbuild/protobuf';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { resolve } from 'node:path';
import { z } from 'zod';

const timestamp = (value: number | null) => (value ? new Date(value + 1_414_016_075_000).toISOString() : '');

const fastest = (results: SegmentResult[]) => [...results].sort((a, b) => Number(a.elapsedMs - b.elapsedMs));

function resultJSON(result: SegmentResult, count: number) {
  return {
    segmentId: Number(result.segmentId),
    profileId: Number(result.playerId),
    firstInitial: result.firstName[0] ?? '',
    lastName: result.lastName,
    endTime: Date.parse(result.finishTimeStr),
    durationInMilliseconds: Number(result.elapsedMs),
    playerType: 'NORMAL',
    activityId: Number(result.activityId),
    numberOfResults: count,
  };
}

export function recordRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const service = runtime.services.records;

  const records = runtime.services.recordData;

  const races = new Map<bigint, { touched: number; riders: Map<number, RaceResultEntrySaveRequest> }>();

  app.post('/api/segment-results', async (c) => {
    const user = authenticated(c);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const result = parseProtobuf(SegmentResultSchema, bytes);

    if (result.segmentId === 1n) throw new HTTPException(400);
    result.playerId = BigInt(user.player_id);
    result.worldTime = worldTime();
    result.finishTimeStr = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    result.id = BigInt(records.insert('segment_result', SegmentResultSchema, result));
    const sender = runtime.world.online.get(result.playerId);

    if (sender)
      runtime.world.enqueue(
        create(WorldAttributeSchema, {
          serverRealm: 1n,
          waType: WA_TYPE.WAT_SR,
          payload: toBinary(SegmentResultSchema, result),
          worldTimeBorn: worldTime(),
          worldTimeExpire: worldTime() + 60_000n,
          timestamp: BigInt(Date.now()) * 1000n,
        }),
        [...runtime.world.online].flatMap(([id, state]) =>
          id !== result.playerId && (course(sender) === course(state) || state.watchingRiderId === result.playerId)
            ? id
            : [],
        ),
      );

    return c.json({ id: Number(result.id) });
  });
  app.get('/api/personal-records/my-records', (c) => {
    const user = authenticated(c);
    const segment = c.req.query('segmentId');

    if (!segment) throw new HTTPException(422);
    const from = c.req.query('from');
    const to = c.req.query('to');

    const results = fastest(
      service
        .mine(user.player_id, undefined, segment)
        .filter(
          (item) =>
            (!from || runtime.config.leaderboards.allTime || Date.parse(item.finishTimeStr) > Date.parse(from)) &&
            (!to || Date.parse(item.finishTimeStr) < Date.parse(to)),
        ),
    ).slice(0, 100);

    for (const result of results)
      for (const field of [
        'serverRealm',
        'courseId',
        'segmentId',
        'eventSubgroupId',
        'finishTimeStr',
        'f14',
        'time',
        'playerType',
        'f22',
        'f23',
      ]) {
        const descriptor = SegmentResultSchema.fields.find((item) => item.localName === field);

        if (descriptor) clearField(result, descriptor);
      }

    return c.body(
      toBinary(
        SegmentResultsSchema,
        create(SegmentResultsSchema, {
          serverRealm: 1n,
          segmentId: BigInt(segment),
          segmentResults: results,
        }),
      ),
    );
  });
  app.get('/api/personal-records/my-segment-ride-stats/:sport', (c) => {
    const user = authenticated(c);
    const segment = c.req.query('segmentId');

    if (!segment) throw new HTTPException(422);

    const results = service.mine(user.player_id, c.req.param('sport'), segment);
    const best = fastest(results)[0];
    const latest = [...results].sort((a, b) => Number(b.worldTime - a.worldTime) || Number(b.id - a.id))[0];

    const stats = create(SegmentRideStatsSchema, {
      segmentId: BigInt(segment),
    });

    if (best && latest) {
      stats.numberOfResults = results.length;
      stats.latestTime = latest.elapsedMs;
      stats.bestTime = best.elapsedMs;
      stats.latestPercentile = 100;
      stats.bestPercentile = 100;
    }

    return c.body(toBinary(SegmentRideStatsSchema, stats));
  });
  app.get('/api/personal-records/results/summary/profiles/me/:sport', (c) => {
    const user = authenticated(c);
    const sport = c.req.param('sport');
    const segments = c.req.queries('segmentIds') ?? [];

    return c.json({
      query: {
        name: 'AllTimeBestResultsForSegments',
        labelsAre: 'SEGMENT_ID',
        sport,
        segmentIds: segments,
      },
      results: segments.flatMap((segment) => {
        const results = fastest(service.mine(user.player_id, sport, segment));

        return results[0] ? { label: segment, result: resultJSON(results[0], results.length) } : [];
      }),
    });
  });
  app.get('/api/personal-records/results/summary/profiles/me/:sport/segments/:segment/by-quarter', (c) => {
    const user = authenticated(c);
    const { sport, segment } = c.req.param();
    const quarters = new Map<string, SegmentResult[]>();

    for (const result of service.mine(user.player_id, sport, segment)) {
      const date = new Date(result.finishTimeStr);
      const key = `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
      const entries = quarters.get(key) ?? [];
      entries.push(result);
      quarters.set(key, entries);
    }

    return c.json({
      query: {
        name: 'QuarterlyRecordsForSegment',
        labelsAre: 'YEAR-QUARTER',
        sport,
        segmentId: segment,
      },
      results: [...quarters]
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([label, items]) => {
          const best = fastest(items)[0];

          return best ? { label, result: resultJSON(best, items.length) } : [];
        }),
    });
  });
  app.get('/api/personal-records/results/summary/profiles/me/:sport/segments/:segment/date/:year/:quarter/all', (c) => {
    const user = authenticated(c);
    const { sport, segment, year, quarter } = c.req.param();

    const results = service.mine(user.player_id, sport, segment).filter((result) => {
      const date = new Date(result.finishTimeStr);

      return (
        date.getUTCFullYear() === Number(year) &&
        Math.floor(date.getUTCMonth() / 3) + 1 === Number(quarter.replace('Q', ''))
      );
    });

    return c.json({
      query: {
        name: 'AllResultsInQuarterForSegment',
        labelsAre: 'END_TIME',
        sport,
        segmentId: segment,
        year,
        quarter,
      },
      results: results.map((result) => ({
        label: String(Date.parse(result.finishTimeStr)),
        result: resultJSON(result, 1),
      })),
    });
  });
  app.on(
    'GET',
    ['/live-segment-results-service/leaders', '/live-segment-results-service/leaderboard/:segment'],
    (c) => {
      const segment = c.req.path.split('/', 4)[3];

      const best = new Map<string, SegmentResult>();

      for (const row of service.segmentLeaderboard()) {
        const result = records.decode(SegmentResultSchema, row);

        if (
          (segment && result.segmentId !== BigInt(segment)) ||
          (!runtime.config.leaderboards.allTime && result.worldTime <= worldTime() - 3_600_000n)
        )
          continue;
        const key = `${result.segmentId}:${result.playerId}`;

        if (best.has(key)) continue;

        if (runtime.config.leaderboards.allTime && result.worldTime <= worldTime() - 3_600_000n) {
          result.playerId += 100_000n;
          result.worldTime = worldTime();
        }

        best.set(key, result);
      }

      return c.body(
        toBinary(
          SegmentResultsSchema,
          create(SegmentResultsSchema, {
            serverRealm: 0n,
            segmentId: BigInt(segment || 0),
            segmentResults: best.values().take(100).toArray(),
          }),
        ),
      );
    },
  );
  app.post('/api/route-results', async (c) => {
    const user = authenticated(c);

    const result = parseProtobuf(RouteResultSaveRequestSchema, new Uint8Array(await c.req.arrayBuffer()));

    const id = records.insert('route_result', RouteResultSaveRequestSchema, result);

    service.updateRouteResult(user.player_id, id);

    return c.body(null, 202);
  });
  app.get('/api/route-results/completion-stats/all', (c) => {
    const user = authenticated(c);

    const page = z.coerce
      .number()
      .int()
      .min(0)
      .parse(c.req.query('page') ?? 0);

    const size = z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .parse(c.req.query('pageSize') ?? 100);

    runtime.services.records.backfillRoutes(user.player_id);

    const rows = service.listRouteResult(user.player_id);

    const stats = rows.map((row) => {
      const item = z
        .object({
          route_hash: z.number(),
          first: z.number().nullable(),
          last: z.number().nullable(),
        })
        .parse(row);

      return {
        routeHash: item.route_hash,
        firstCompletedAt: timestamp(item.first),
        lastCompletedAt: timestamp(item.last),
      };
    });

    const pageCount = Math.ceil(stats.length / size);

    return c.json({
      response: { stats: stats.slice(page * size, (page + 1) * size) },
      hasPreviousPage: page > 0,
      hasNextPage: page < pageCount - 1,
      pageCount,
    });
  });

  const unlockPath = (id: number) => resolve(runtime.services.profiles.folder(id), 'route_completion_achievements.bin');

  app.get('/api/achievement/route-completion-achievements', (c) => {
    const user = authenticated(c);

    const response = fromJsonString(
      LoadPlayerRouteCompletionAchievementsResponseSchema,
      runtime.services.files.read(resolve(runtime.assets, 'data/route_completion_achievement.txt'), 'utf8'),
    );

    const file = unlockPath(user.player_id);

    const unlocked = runtime.services.files.exists(file)
      ? fromBinary(RouteCompletionAchievementUnlockRequestSchema, runtime.services.files.read(file)).achievementUuids
      : [];

    for (const achievement of response.achievements)
      if (unlocked.includes(achievement.achievementUuid)) achievement.unlocked = true;

    return c.body(toBinary(LoadPlayerRouteCompletionAchievementsResponseSchema, response));
  });
  app.post('/api/achievement/route-completion-achievement-unlocks', async (c) => {
    const user = authenticated(c);

    const incoming = parseProtobuf(
      RouteCompletionAchievementUnlockRequestSchema,
      new Uint8Array(await c.req.arrayBuffer()),
    );

    const file = unlockPath(user.player_id);

    const old = runtime.services.files.exists(file)
      ? fromBinary(RouteCompletionAchievementUnlockRequestSchema, runtime.services.files.read(file))
      : create(RouteCompletionAchievementUnlockRequestSchema);

    old.achievementUuids = [...new Set([...old.achievementUuids, ...incoming.achievementUuids])];
    runtime.services.files.write(file, toBinary(RouteCompletionAchievementUnlockRequestSchema, old), true);

    return c.body(null, 202);
  });
  app.post('/api/race-results', async (c) => {
    const user = authenticated(c);

    const result = parseProtobuf(RaceResultEntrySaveRequestSchema, new Uint8Array(await c.req.arrayBuffer()));

    for (const [id, race] of races) if (Date.now() - race.touched > 3_600_000) races.delete(id);

    const race = races.get(result.eventSubgroupId) ?? {
      touched: 0,
      riders: new Map(),
    };

    race.touched = Date.now();
    race.riders.set(user.player_id, result);
    races.set(result.eventSubgroupId, race);

    return c.body(null, 202);
  });
  app.get('/api/race-results/summary', (c) => {
    authenticated(c);
    const id = BigInt(c.req.query('event_subgroup_id') ?? '0');

    const sorted = [...(races.get(id)?.riders ?? [])].sort(([, a], [, b]) =>
      Number((a.activityData?.worldTime ?? 0n) - (b.activityData?.worldTime ?? 0n)),
    );

    const entries = sorted.map(([playerId, result], index) => {
      const profile = runtime.services.profiles.get(playerId);

      const entry = create(RaceResultEntrySchema, {
        playerId: BigInt(playerId),
        eventSubgroupId: id,
        position: index + 1,
        eventId: id,
        activityData: result.activityData ? { ...result.activityData } : undefined,
        powerData: result.powerData,
        sensorData: result.sensorData,
        profileData: create(RaceResultEntryProfileDataSchema, {
          weightInGrams: profile.weightInGrams,
          heightInCentimeters: Math.floor(profile.heightInMillimeters / 10),
          gender: profile.isMale ? 1 : 2,
          playerType: profile.playerType,
          firstName: profile.firstName,
          lastName: profile.lastName,
          avatarUrl: runtime.services.files.exists(
            resolve(runtime.services.profiles.folder(playerId), 'avatarLarge.jpg'),
          )
            ? `https://us-or-rly101.zwift.com/download/${playerId}/avatarLarge.jpg`
            : '',
        }),
      });

      if (entry.activityData) {
        entry.activityData.time = entry.activityData.worldTime + 1_414_016_074_397n;
        const meetup = service.findPrivateEvent(id);

        if (meetup) {
          const { eventStart } = z
            .object({ eventStart: z.iso.datetime() })
            .parse(JSON.parse(z.string().parse(meetup.json)));

          entry.activityData.elapsedMs = entry.activityData.time - BigInt(Date.parse(eventStart));
        }

        entry.time = entry.activityData.time;
        entry.distanceToLeader = Number(entry.activityData.worldTime - (sorted[0]?.[1].activityData?.worldTime ?? 0n));
      }

      return clone(RaceResultEntrySchema, entry);
    });

    return c.body(
      toBinary(
        RaceResultSummarySchema,
        create(RaceResultSummarySchema, {
          f1: entries,
          f2: entries,
          total: entries.length,
        }),
      ),
    );
  });
}
