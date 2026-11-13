import { Sport } from '#src/protocol/generated/profile_pb';
import {
  SegmentResultSchema,
  SegmentResultsSchema,
  SegmentRideStatsSchema,
} from '#src/protocol/generated/segment-result_pb';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { worldTime } from '#src/world/state';
import { runtimeFixture } from '#tests/support/runtime';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('segment records preserve sport and distinguish the latest effort from the fastest', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Record Rider', '', true);
  const headers = { Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}` };
  const segmentId = 9_223_372_036_854_775_807n;
  f.world.receive(
    BigInt(user.player_id),
    create(PlayerStateSchema, { id: BigInt(user.player_id), roadTime: 1, worldTime: worldTime() }),
  );
  f.world.receive(99n, create(PlayerStateSchema, { id: 99n, roadTime: 1, worldTime: worldTime() }));

  for (const [sport, elapsedMs] of [
    [Sport.RUNNING, 1000n],
    [Sport.RUNNING, 2000n],
    [Sport.CYCLING, 500n],
  ] satisfies [Sport, bigint][]) {
    const response = await f.app.request('/api/segment-results', {
      method: 'POST',
      headers,
      body: toBinary(
        SegmentResultSchema,
        create(SegmentResultSchema, {
          playerId: 999n,
          segmentId,
          firstName: 'R',
          lastName: 'Rider',
          sport,
          elapsedMs,
        }),
      ),
    });

    assert.equal(response.status, 200);
  }

  const response = await f.app.request(`/api/personal-records/my-segment-ride-stats/RUNNING?segmentId=${segmentId}`, {
    headers,
  });

  assert.equal(response.status, 200);
  const stats = fromBinary(SegmentRideStatsSchema, new Uint8Array(await response.arrayBuffer()));
  assert.equal(stats.numberOfResults, 2);
  assert.equal(stats.latestTime, 2000n);
  assert.equal(stats.bestTime, 1000n);
  const update = f.world.updates.get(99n)?.[0];
  assert.ok(update);
  const broadcast = fromBinary(SegmentResultSchema, update.payload);
  assert.equal(broadcast.playerId, BigInt(user.player_id));
  assert.equal(broadcast.sport, Sport.RUNNING);
  assert.ok(broadcast.id > 0n);

  const leaders = await f.app.request(`/live-segment-results-service/leaderboard/${segmentId}`);
  assert.equal(leaders.status, 200);
  const leaderboard = fromBinary(SegmentResultsSchema, new Uint8Array(await leaders.arrayBuffer()));
  assert.equal(leaderboard.segmentId, segmentId);
  assert.equal(leaderboard.segmentResults[0]?.elapsedMs, 500n);
});
