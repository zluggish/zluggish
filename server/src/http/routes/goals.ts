import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { z } from 'zod';
import { GoalSchema, GoalsSchema } from '#src/protocol/generated/goal_pb';
import type { Goal } from '#src/protocol/generated/goal_pb';
import { ProtobufRows } from '#src/node/persistence/protobuf';
import type { Runtime, RuntimeEnv } from '#src/http/runtime';
import { authenticated } from '#src/http/routes/accounts';

const goalInput = z.object({
  id: z.number().int().nonnegative().default(0),
  profileId: z.number().int().positive(),
  sport: z.enum(['CYCLING', 'RUNNING']),
  name: z.string(),
  type: z.union([z.literal(0), z.literal(1)]),
  periodicity: z.union([z.literal(0), z.literal(1)]),
  targetDistanceInMeters: z.number(),
  targetDurationInMinutes: z.number(),
  actualDistanceInMeters: z.number().default(0),
  actualDurationInMinutes: z.number().default(0),
});

function jsonGoal(goal: Goal) {
  const timestamp = (time: bigint) => (time ? new Date(Number(time)).toISOString().replace('Z', '+0000') : null);

  return {
    id: Number(goal.id),
    profileId: Number(goal.playerId),
    sport: goal.sport === 1 ? 'RUNNING' : 'CYCLING',
    name: goal.name,
    type: goal.type,
    periodicity: goal.periodicity,
    targetDistanceInMeters: goal.targetDistance,
    targetDurationInMinutes: goal.targetDuration,
    actualDistanceInMeters: goal.actualDistance,
    actualDurationInMinutes: goal.actualDuration,
    createdOn: timestamp(goal.createdOn),
    periodEndDate: timestamp(goal.periodEndDate),
    status: goal.status,
    timezone: goal.timezone,
  };
}

function parseGoal(body: z.infer<typeof goalInput>) {
  return create(GoalSchema, {
    id: BigInt(body.id),
    playerId: BigInt(body.profileId),
    sport: body.sport === 'RUNNING' ? 1 : 0,
    name: body.name,
    type: body.type,
    periodicity: body.periodicity,
    status: 0,
    targetDistance: body.targetDistanceInMeters,
    targetDuration: body.targetDurationInMinutes,
    actualDistance: body.actualDistanceInMeters,
    actualDuration: body.actualDurationInMinutes,
  });
}

export function goalRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const records = new ProtobufRows(runtime.accounts.db);

  function progress(goal: Goal) {
    const now = new Date();

    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    let end: Date;

    if (goal.periodicity === 0) {
      start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
      end = new Date(start.getTime() + 7 * 86_400_000 - 1000);
    } else {
      start.setUTCDate(1);
      end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1) - 1000);
    }

    goal.periodEndDate = BigInt(end.getTime());

    const row = runtime.accounts.db
      .prepare(
        `SELECT SUM(distanceInMeters) AS distance, SUM((julianday(end_date)-julianday(start_date))*1440) AS duration FROM activity WHERE player_id=? AND sport=? AND julianday(start_date) BETWEEN julianday(?) AND julianday(?)`,
      )
      .get(goal.playerId, goal.sport, start.toISOString(), end.toISOString());

    const totals = z
      .object({
        distance: z.number().nullable(),
        duration: z.number().nullable(),
      })
      .parse(row);

    const value = (goal.type === 0 ? totals.distance : totals.duration) ?? 0;
    goal.actualDistance = value;
    goal.actualDuration = value;
  }

  app.on(['GET', 'POST'], '/api/profiles/:id/goals', async (c) => {
    const user = authenticated(c);

    if (String(user.player_id) !== c.req.param('id')) throw new HTTPException(401);
    const json = c.req.header('Accept')?.includes('application/json');

    if (c.req.method === 'POST') {
      const goal = c.req.header('Content-Type')?.includes('application/x-protobuf-lite')
        ? fromBinary(GoalSchema, new Uint8Array(await c.req.arrayBuffer()))
        : parseGoal(goalInput.parse(await c.req.json()));

      goal.playerId = BigInt(user.player_id);
      goal.createdOn = BigInt(Date.now());
      progress(goal);
      goal.id = BigInt(records.insert('goal', GoalSchema, goal));

      return json ? c.json(jsonGoal(goal)) : c.body(toBinary(GoalSchema, goal));
    }

    const goals = records.select('goal', GoalSchema, BigInt(user.player_id)).slice(0, 100);

    for (const goal of goals) {
      progress(goal);
      records.update('goal', goal.id, GoalSchema, goal);
    }

    return json
      ? c.json(goals.map((goal) => jsonGoal(goal)))
      : c.body(toBinary(GoalsSchema, create(GoalsSchema, { goals })));
  });
  app.on(['PUT', 'DELETE'], '/api/profiles/:id/goals/:goalId', async (c) => {
    const user = authenticated(c);

    if (String(user.player_id) !== c.req.param('id')) throw new HTTPException(401);
    const id = BigInt(c.req.param('goalId'));

    if (!runtime.accounts.db.prepare('SELECT id FROM goal WHERE id=? AND player_id=?').get(id, user.player_id))
      throw new HTTPException(404);

    if (c.req.method === 'DELETE') {
      runtime.accounts.db.prepare('DELETE FROM goal WHERE id=? AND player_id=?').run(id, user.player_id);

      return c.body(null, 200);
    }

    const body = goalInput.parse(await c.req.json());
    const goal = parseGoal(body);
    goal.id = id;
    goal.playerId = BigInt(user.player_id);
    records.update('goal', id, GoalSchema, goal);

    return c.json(body);
  });
}
