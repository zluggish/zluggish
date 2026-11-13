import { parseProtobuf } from '#src/http/protobuf';
import { authenticated } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import { GoalSchema, GoalsSchema } from '#src/protocol/generated/goal_pb';
import { goalInput, GoalService } from '#src/services/goals.service';
import { create, toBinary } from '@bufbuild/protobuf';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

export function goalRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const service = runtime.services.goals;

  app.on(['GET', 'POST'], '/api/profiles/:id/goals', async (c) => {
    const user = authenticated(c);

    if (String(user.player_id) !== c.req.param('id')) throw new HTTPException(401);
    const json = c.req.header('Accept')?.includes('application/json');

    if (c.req.method === 'POST') {
      const goal = c.req.header('Content-Type')?.includes('application/x-protobuf-lite')
        ? parseProtobuf(GoalSchema, new Uint8Array(await c.req.arrayBuffer()))
        : GoalService.parseGoal(goalInput.parse(await c.req.json()));

      service.create(user.player_id, goal);

      return json ? c.json(GoalService.jsonGoal(goal)) : c.body(toBinary(GoalSchema, goal));
    }

    const goals = service.list(user.player_id);

    return json
      ? c.json(goals.map((goal) => GoalService.jsonGoal(goal)))
      : c.body(toBinary(GoalsSchema, create(GoalsSchema, { goals })));
  });
  app.on(['PUT', 'DELETE'], '/api/profiles/:id/goals/:goalId', async (c) => {
    const user = authenticated(c);

    if (String(user.player_id) !== c.req.param('id')) throw new HTTPException(401);
    const id = BigInt(c.req.param('goalId'));
    service.requireOwned(user.player_id, id);

    if (c.req.method === 'DELETE') {
      service.delete(user.player_id, id);

      return c.body(null, 200);
    }

    const body = goalInput.parse(await c.req.json());
    const goal = GoalService.parseGoal(body);
    service.update(user.player_id, id, goal);

    return c.json(body);
  });
}
