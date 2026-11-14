import { GoalSchema, GoalsSchema } from '#src/protocol/generated/goal_pb';
import { runtimeFixture } from '#tests/support/runtime';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('weekly and monthly goals mirror the selected metric for legacy clients', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 12, 12) });
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Goal Rider', '', true);
  const other = await f.accounts.create('Other Rider', '');

  const headers = {
    Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}`,
    'Content-Type': 'application/x-protobuf-lite',
  };

  const insert = f.accounts.db.prepare(
    'INSERT INTO activity (player_id,sport,start_date,end_date,distanceInMeters) VALUES (?,?,?,?,?)',
  );

  insert.run(user.player_id, 0, '2026-11-12T10:00:00Z', '2026-11-12T10:10:00Z', 12_345);
  insert.run(user.player_id, 0, '2026-11-08T10:00:00Z', '2026-11-08T10:20:00Z', 5000);
  insert.run(user.player_id, 0, '2026-10-31T10:00:00Z', '2026-10-31T11:00:00Z', 99_999);
  insert.run(user.player_id, 1, '2026-11-12T10:00:00Z', '2026-11-12T11:00:00Z', 99_999);
  insert.run(other.player_id, 0, '2026-11-12T10:00:00Z', '2026-11-12T11:00:00Z', 99_999);

  for (const periodicity of [0, 1]) {
    const response = await f.app.request(`/api/profiles/${user.player_id}/goals`, {
      method: 'POST',
      headers,
      body: toBinary(
        GoalSchema,
        create(GoalSchema, {
          playerId: BigInt(user.player_id),
          name: 'Progress',
          type: periodicity,
          periodicity,
          sport: 0,
          targetDistance: 20_000,
          targetDuration: 60,
        }),
      ),
    });

    assert.equal(response.status, 200);
    const goal = fromBinary(GoalSchema, new Uint8Array(await response.arrayBuffer()));
    assert.ok(Math.abs(goal.actualDistance - (periodicity === 0 ? 12_345 : 30)) < 0.001);
    assert.equal(goal.actualDuration, goal.actualDistance);
    assert.equal(
      goal.periodEndDate,
      BigInt(Date.parse(periodicity === 0 ? '2026-11-15T23:59:59Z' : '2026-11-30T23:59:59Z')),
    );
  }

  const response = await f.app.request(`/api/profiles/${user.player_id}/goals`, { headers });
  assert.equal(response.status, 200);
  const saved = fromBinary(GoalsSchema, new Uint8Array(await response.arrayBuffer()));
  assert.equal(saved.goals[0]?.actualDistance, 12_345);
  assert.ok(Math.abs((saved.goals[1]?.actualDistance ?? 0) - 30) < 0.001);
  assert.ok(saved.goals.every((goal) => goal.playerId === BigInt(user.player_id)));
});
