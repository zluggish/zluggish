import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Runtime, RuntimeEnv } from '#src/http/runtime';
import { accountRoutes, authenticated } from '#src/http/routes/accounts';
import { profileRoutes } from '#src/http/routes/profiles';
import { activityRoutes } from '#src/http/routes/activities';
import { storageRoutes } from '#src/http/routes/storage';
import { settingsRoutes } from '#src/http/routes/settings';
import { staticRoutes } from '#src/http/routes/static';
import { goalRoutes } from '#src/http/routes/goals';
import { recordRoutes } from '#src/http/routes/records';
import { fitnessRoutes } from '#src/http/routes/fitness';
import { workoutRoutes } from '#src/http/routes/workouts';
import { eventRoutes } from '#src/http/routes/events';
import { socialRoutes } from '#src/http/routes/social';
import { integrationRoutes } from '#src/http/routes/integrations';
import { assetRoutes } from '#src/http/routes/assets';
import { relayRoutes } from '#src/http/routes/relay';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { clone, create, fromBinary, fromJsonString, toBinary } from '@bufbuild/protobuf';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Rider } from '#src/domain/accounts/repository';
import {
  FeatureRequestSchema,
  FeatureResponseSchema,
  FeatureResponse_ParamsSchema,
  StructSchema,
  ValueSchema,
} from '#src/protocol/generated/variants_pb';
import type { FeatureResponse_Params } from '#src/protocol/generated/variants_pb';

export interface PublicMetadata {
  gameInfo: string;
  gameInfoHash: string;
  variants: string;
}

/** HTTP composition has no file/database/listener side effects. */
export function createApp(metadata: PublicMetadata, runtime?: Runtime) {
  const app = new Hono<RuntimeEnv>();
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
    staticRoutes(app);
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
    let request;

    try {
      request = fromBinary(FeatureRequestSchema, bytes);
    } catch {
      throw new HTTPException(400, { message: 'Invalid request' });
    }

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
      const file = resolve(runtime.profiles.folder(rider.player_id), 'variants.txt');

      if (existsSync(file))
        try {
          for (const variant of fromJsonString(FeatureResponseSchema, readFileSync(file, 'utf8')).variants)
            known.set(variant.name, variant);
        } catch {
          console.warn(`Ignoring invalid variants override for ${rider.player_id}`);
        }
    }

    const mochi = known.get('game_mochi');

    if (runtime && mochi && existsSync(resolve(runtime.config.storageDir, 'mochi/watopian/watopian.manifest.json'))) {
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
    if (error instanceof HTTPException) return error.getResponse();

    if (error instanceof z.ZodError) return c.text('Invalid request', 400);

    return c.text('Request failed', 500);
  });

  return app;
}
