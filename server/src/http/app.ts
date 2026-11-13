import { log } from '#src/logging';
import { ApplicationError } from '#src/errors';
import { parseProtobuf } from '#src/http/protobuf';
import { accountRoutes, authenticated } from '#src/http/routes/accounts';
import { activityRoutes } from '#src/http/routes/activities';
import { assetRoutes } from '#src/http/routes/assets';
import { eventRoutes } from '#src/http/routes/events';
import { fitnessRoutes } from '#src/http/routes/fitness';
import { goalRoutes } from '#src/http/routes/goals';
import { integrationRoutes } from '#src/http/routes/integrations';
import { profileRoutes } from '#src/http/routes/profiles';
import { recordRoutes } from '#src/http/routes/records';
import { relayRoutes } from '#src/http/routes/relay';
import { settingsRoutes } from '#src/http/routes/settings';
import { socialRoutes } from '#src/http/routes/social';
import { staticRoutes } from '#src/http/routes/static';
import { storageRoutes } from '#src/http/routes/storage';
import { workoutRoutes } from '#src/http/routes/workouts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import type { FeatureResponse_Params } from '#src/protocol/generated/variants_pb';
import {
  FeatureRequestSchema,
  FeatureResponse_ParamsSchema,
  FeatureResponseSchema,
  StructSchema,
  ValueSchema,
} from '#src/protocol/generated/variants_pb';
import type { Rider } from '#src/repositories/accounts.repository';
import { clone, create, fromJsonString, toBinary } from '@bufbuild/protobuf';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import { resolve } from 'node:path';
import { z } from 'zod';

export interface PublicMetadata {
  gameInfo: string;
  gameInfoHash: string;
  variants: string;
}

export function createApp(metadata: PublicMetadata, runtime?: Runtime) {
  const app = new Hono<RuntimeEnv>();
  app.use(
    '*',
    logger((message) => log.info(message)),
  );
  const variants = fromJsonString(FeatureResponseSchema, metadata.variants);

  const byName = new Map(variants.variants.map((variant) => [variant.name, variant]));

  app.use('*', bodyLimit({ maxSize: 16 * 1024 * 1024 }));

  if (runtime) {
    accountRoutes(app, runtime);
    profileRoutes(app, runtime);
    relayRoutes(app, runtime);
    activityRoutes(app, runtime);
    storageRoutes(app, runtime);
    settingsRoutes(app, runtime);
    goalRoutes(app, runtime);
    recordRoutes(app, runtime);
    fitnessRoutes(app, runtime);
    workoutRoutes(app, runtime);
    eventRoutes(app, runtime);
    socialRoutes(app, runtime);
    integrationRoutes(app, runtime);
    assetRoutes(app, runtime);
    staticRoutes(app, runtime);
  }

  app.get('/health', (c) => c.json({ status: 'ok', implementation: 'typescript', rideReady: false }));
  app.get('/', (c) =>
    c.html(
      '<!doctype html><title>Zluggish development server</title><h1>Zluggish</h1><p>The TypeScript server is under development. Client compatibility is awaiting manual verification.</p>',
    ),
  );
  app.get('/api/game_info/version', (c) => c.json({ version: metadata.gameInfoHash }));
  app.get('/api/game_info', (c) => c.body(metadata.gameInfo, 200, { 'Content-Type': 'application/json' }));

  function variantResponse(bytes: Uint8Array, known: Map<string, FeatureResponse_Params>) {
    const request = parseProtobuf(FeatureRequestSchema, bytes);

    const response = create(FeatureResponseSchema);

    for (const params of request.params) {
      for (const param of params.param)
        response.variants.push(known.get(param) ?? create(FeatureResponse_ParamsSchema, { name: param }));
    }

    return toBinary(FeatureResponseSchema, response);
  }

  function variantsFor(rider: Rider | null) {
    const known = new Map(byName);

    if (runtime && rider) {
      const file = resolve(runtime.services.profiles.folder(rider.player_id), 'variants.txt');

      if (runtime.services.files.exists(file))
        try {
          for (const variant of fromJsonString(FeatureResponseSchema, runtime.services.files.read(file, 'utf8'))
            .variants)
            known.set(variant.name, variant);
        } catch {
          log.warn(`Ignoring invalid variants override for ${rider.player_id}`);
        }
    }

    const mochi = known.get('game_mochi');

    if (
      runtime &&
      mochi &&
      runtime.services.files.exists(resolve(runtime.config.storageDir, 'mochi/watopian/watopian.manifest.json'))
    ) {
      const copy = clone(FeatureResponse_ParamsSchema, mochi);
      const values = copy.values ?? create(StructSchema);

      values.fields.server_address = create(ValueSchema, {
        kind: { case: 'stringValue', value: 'https://cdn.zwift.com/mochi' },
      });
      copy.values = values;
      known.set('game_mochi', copy);
    }

    return known;
  }

  app.post('/experimentation/v1/machine-id-variant', async (c) =>
    c.body(variantResponse(new Uint8Array(await c.req.arrayBuffer()), variantsFor(null)), 200, {
      'Content-Type': 'text/html; charset=utf-8',
    }),
  );

  if (runtime)
    app.post('/experimentation/v1/variant', async (c) =>
      c.body(variantResponse(new Uint8Array(await c.req.arrayBuffer()), variantsFor(authenticated(c))), 200, {
        'Content-Type': 'text/html; charset=utf-8',
      }),
    );
  app.onError((error, c) => {
    if (error instanceof ApplicationError)
      return new HTTPException(error.status, { message: error.message }).getResponse();

    if (error instanceof HTTPException) return error.getResponse();

    if (error instanceof z.ZodError) return c.text('Invalid request', 400);

    log.error(`Request failed: ${c.req.method} ${c.req.path}`, error);

    return c.text('Request failed', 500);
  });

  return app;
}
