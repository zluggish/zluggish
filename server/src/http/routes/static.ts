import type { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  SaveStructuredEventRequestSchema,
  SaveStructuredEventResponseSchema,
} from '#src/protocol/generated/structured_events_pb';
import { packageRoot } from '#src/config/load';
import type { RuntimeEnv } from '#src/http/runtime';
import { authenticated } from '#src/http/routes/accounts';

const contracts = z.array(
  z.object({
    methods: z.array(z.enum(['GET', 'POST', 'PUT', 'DELETE'])),
    path: z.string(),
    body: z.json(),
    mode: z.enum(['json', 'text']),
    authenticated: z.boolean(),
    status: z.union([
      z.literal(200),
      z.literal(201),
      z.literal(202),
      z.literal(204),
      z.literal(400),
      z.literal(404),
      z.literal(500),
    ]),
  }),
);

export function staticRoutes(app: Hono<RuntimeEnv>) {
  const routes = contracts.parse(
    JSON.parse(readFileSync(resolve(packageRoot(), 'assets/static-responses.json'), 'utf8')),
  );

  for (const route of routes)
    app.on(route.methods, route.path, (c) => {
      if (route.authenticated) authenticated(c);

      if (route.status === 204) return c.body(null, 204);

      return c.body(route.mode === 'json' ? JSON.stringify(route.body) : String(route.body), route.status, {
        'Content-Type': route.mode === 'json' ? 'application/json' : 'text/html; charset=utf-8',
      });
    });

  app.get('/api/head-unit-bff/*', (c) => {
    const path = c.req.path.slice('/api/head-unit-bff/'.length);

    return c.json(path === 'carousels/home-challenges' ? { items: [] } : path === 'crm' ? {} : []);
  });
  app.post('/api/actions-service/structured-events/batch', async (c) => {
    const request = fromBinary(SaveStructuredEventRequestSchema, new Uint8Array(await c.req.arrayBuffer()));

    return c.body(
      toBinary(
        SaveStructuredEventResponseSchema,
        create(SaveStructuredEventResponseSchema, {
          sequenceNumber: request.sequenceNumber,
        }),
      ),
      202,
    );
  });
}
