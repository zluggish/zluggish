import { DurabilityService } from '#src/services/durability.service';
import { FilesService } from '#src/services/files.service';
import { ProfilesService } from '#src/services/profile.service';
import { packageVersion } from '#src/config/load';
import { browserJson } from '#src/http/game/results';
import { ApplicationError } from '#src/errors';
import { parseProtobuf } from '#src/http/protobuf';
import { rideCompletionRoutes } from '#src/http/routes/ride-completion';
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
import type { User } from '#src/repositories/accounts.repository';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { LoggingRepository } from '#src/repositories/logging.repository';
import { clone, create, fromJsonString, toBinary } from '@bufbuild/protobuf';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { resolve } from 'node:path';
import { fieldErrors } from '#src/schema';
import { Schema } from 'effect';

export interface PublicMetadata {
  gameInfo: string;
  gameInfoHash: string;
  variants: string;
}

export function createGameApp(metadata: PublicMetadata, runtime?: Runtime) {
  const app = new Hono<RuntimeEnv>();
  const log = runtime?.world.lifecycle.log ?? new LoggingRepository();
  app.use('*', async (c, next) => {
    const requestId = new CryptoRepository().randomUUID();
    c.set('requestId', requestId);
    const started = performance.now();
    await next();
    log.verbose('http.completed', 'Request completed', {
      requestId,
      method: c.req.method,
      route: c.req.routePath === '*' ? 'unmatched' : c.req.routePath,
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
    });
  });
  const variants = fromJsonString(FeatureResponseSchema, metadata.variants);

  const byName = new Map(variants.variants.map((variant) => [variant.name, variant]));

  app.use('*', bodyLimit({ maxSize: 16 * 1024 * 1024 }));

  if (runtime) {
    app.use('*', async (_c, next) => {
      const durability = runtime.effects.runSync(DurabilityService);
      const before = runtime.effects.runSync(durability.changes());
      await next();

      // A save is acknowledged by its response: the WAL is flushed before it leaves.
      if (runtime.effects.runSync(durability.changes()) !== before) {
        await runtime.effects.runPromise(durability.flush());
      }
    });
  }

  if (runtime) {
    rideCompletionRoutes(app, runtime);
    accountRoutes(app, runtime);
    profileRoutes(app, runtime);
    relayRoutes(app, runtime);
    activityRoutes(app, runtime);
    storageRoutes(app, runtime);
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

  app.get('/health/launcher', (c) =>
    c.text('zluggish launcher', 200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    }),
  );
  app.get('/health', (c) => c.json({ name: 'zluggish', version: packageVersion(), status: 'ok' }));
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
      for (const param of params.param) {
        response.variants.push(known.get(param) ?? create(FeatureResponse_ParamsSchema, { name: param }));
      }
    }

    return toBinary(FeatureResponseSchema, response);
  }

  function variantsFor(user: User | null) {
    const known = new Map(byName);

    if (runtime && user) {
      const file = resolve(
        runtime.effects.runSync(ProfilesService.use((service) => service.folder(user.player_id))),
        'variants.txt',
      );

      const files = runtime.effects.runSync(FilesService);

      if (runtime.effects.runSync(files.exists(file))) {
        try {
          for (const variant of fromJsonString(FeatureResponseSchema, runtime.effects.runSync(files.readText(file)))
            .variants) {
            known.set(variant.name, variant);
          }
        } catch {
          log.warn('config.variants_invalid', 'Ignoring invalid variants override', { playerId: user.player_id });
        }
      }
    }

    const mochi = known.get('game_mochi');

    if (
      runtime &&
      mochi &&
      runtime.effects.runSync(
        FilesService.use((files) =>
          files.exists(resolve(runtime.config.storageDir, 'mochi/watopian/watopian.manifest.json')),
        ),
      )
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

  if (runtime) {
    app.post('/experimentation/v1/variant', async (c) =>
      c.body(variantResponse(new Uint8Array(await c.req.arrayBuffer()), variantsFor(authenticated(c))), 200, {
        'Content-Type': 'text/html; charset=utf-8',
      }),
    );
  }
  app.onError((error, c) => {
    if (browserJson(c)) {
      c.header('Cache-Control', 'no-store');

      if (Schema.isSchemaError(error)) {
        return c.json({ ok: false, message: 'Check the form fields.', fieldErrors: fieldErrors(error) }, 400);
      }

      if (error instanceof HTTPException || error instanceof ApplicationError) {
        const status = error.status;
        const reload = status === 401 || error.message.includes('Reload') || error.message.includes('expired');

        return c.json({ ok: false, message: error.message || 'The request was refused.', reload }, status);
      }

      log.error('http.failed', 'Game app request failed', { requestId: c.get('requestId'), error });

      return c.json({ ok: false, message: 'Could not save. Try again.' }, 500);
    }

    if (error instanceof ApplicationError) {
      return new HTTPException(error.status, { message: error.message }).getResponse();
    }

    if (error instanceof HTTPException) {
      return error.getResponse();
    }

    if (Schema.isSchemaError(error)) {
      return c.text('Invalid request', 400);
    }

    log.error('http.failed', 'Request failed unexpectedly', {
      requestId: c.get('requestId'),
      method: c.req.method,
      route: c.req.routePath === '*' ? 'unmatched' : c.req.routePath,
      error: error instanceof Error ? error : String(error),
    });

    return c.text('Request failed', 500);
  });

  return app;
}
