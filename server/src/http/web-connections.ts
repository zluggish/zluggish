import { IntervalsAthleteId } from '#src/dtos/intervals.dto';
import { AccountsService } from '#src/services/auth.service';
import { WebSessionsService } from '#src/services/web-session.service';
import { UploadsService } from '#src/services/uploads.service';
import { WorkoutsService } from '#src/services/workout.service';
import { FilesService } from '#src/services/files.service';
import { ProfilesService } from '#src/services/profile.service';
import { ConnectionsService } from '#src/services/connections.service';
import { IntegrationsService } from '#src/services/integrations.service';
import { effectRoutes } from '#src/http/effect';
import { DocumentsService } from '#src/services/documents.service';
import type { Hono } from 'hono';
import { resolve } from 'node:path';
import { Cause, Effect, Schema } from 'effect';
import { NumberFromInput, Strict, withDefault } from '#src/schema';
import { UploadProvider } from '#src/enum';
import { ApplicationError, UnreadableCredentialsError } from '#src/errors';
import type { HttpRuntime } from '#src/http/runtime';
import type { WebEnv } from '#src/http/web-app';
import { GARMIN_DEVICES, defaultSerial, deviceText, parseDeviceIdentity } from '#src/world/fit-device';

const provider = Schema.Literals(['strava', 'garmin', 'intervals']);

const credentials = Strict({
  username: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  secret: Schema.String.check(Schema.isMaxLength(10_000)),
});

const workoutProviders = { intervals: 'intervals-icu', trainingpeaks: 'trainingpeaks' } as const;

const credential = Schema.Literals([
  'strava/api',
  'strava/authorization',
  'strava/cookie',
  'garmin/credentials',
  'garmin/authorization',
]);

/** Credentials stored as rider documents. Removing the Garmin OAuth1 token also removes its OAuth2 token. */
const tokens = {
  'strava/authorization': 'strava_token.txt',
  'strava/cookie': 'strava4_session.txt',
  'garmin/authorization': 'garth/oauth1_token.json',
} as const;

/** A provider failure becomes a message for the rider and a warning with the cause for the
operator. Unreadable credentials keep their own answer: the rider must enter them again.
*/
/** Report any failure of `effect`, typed or not, as `providerFailure` does. */
export function asProviderFailure(runtime: HttpRuntime, status: 400 | 503, message: string) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause) => Effect.fail(providerFailure(runtime, Cause.squash(cause), status, message))),
    );
}

export function providerFailure(runtime: HttpRuntime, cause: unknown, status: 400 | 503, message: string) {
  if (cause instanceof UnreadableCredentialsError) {
    return cause;
  }
  runtime.world.lifecycle.log.warn('connections.provider_failed', message, {
    error: cause instanceof Error ? cause : String(cause),
  });

  return new ApplicationError({ status, message });
}

export function webConnectionRoutes(app: Hono<WebEnv>, runtime: HttpRuntime) {
  const appRoutes = effectRoutes(app, runtime);

  // Credentials the key cannot decrypt stay saved, so the rider is asked to enter them again.
  const saved = Effect.fn('connections.saved')(function* (player: number, name: (typeof provider)['Type']) {
    const connections = yield* ConnectionsService;
    const { credentials, unreadable } = yield* connections.inspect(player, name);

    return { username: credentials?.[0] ?? '', saved: yield* connections.has(player, name), unreadable };
  });

  appRoutes.get('/api/me/connections', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const documentsService = yield* DocumentsService;

      const player = (yield* webSessionsService.require(c.get('sessionId'))).player_id;

      return c.json({
        strava: {
          ...(yield* saved(player, 'strava')),
          authorized: yield* documentsService.has(player, 'strava_token.txt'),
          cookie: yield* documentsService.has(player, 'strava4_session.txt'),
        },
        garmin: {
          ...(yield* saved(player, 'garmin')),
          authorized: yield* documentsService.has(player, 'garth/oauth1_token.json'),
        },
        intervals: yield* saved(player, 'intervals'),
      });
    }),
  );

  // Garmin device routes – registered before the generic :provider routes so garmin/device is not captured.
  appRoutes.get('/api/me/connections/garmin/device', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const documentsService = yield* DocumentsService;

      const player = (yield* webSessionsService.require(c.get('sessionId'))).player_id;

      const text = yield* documentsService.text(player, 'garmin_device.txt');

      return c.json({ device: parseDeviceIdentity(text ?? ''), devices: GARMIN_DEVICES });
    }),
  );

  appRoutes.put('/api/me/connections/garmin/device', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const documentsService = yield* DocumentsService;

      const player = (yield* webSessionsService.require(c.get('sessionId'))).player_id;

      const deviceBody = Strict({
        product: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(65_535)),
        serial: Schema.optional(
          Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(4_294_967_295)),
        ),
      });

      const input = Schema.decodeUnknownSync(deviceBody)(yield* Effect.promise(() => c.req.json()));

      const current = parseDeviceIdentity((yield* documentsService.text(player, 'garmin_device.txt')) ?? '');
      const serial = input.serial ?? current?.serial ?? defaultSerial(player);

      yield* documentsService.put(player, 'garmin_device.txt', deviceText(input.product, serial));

      return c.json({ ok: true });
    }),
  );

  appRoutes.delete('/api/me/connections/garmin/device', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const documentsService = yield* DocumentsService;

      const player = (yield* webSessionsService.require(c.get('sessionId'))).player_id;

      yield* documentsService.remove(player, 'garmin_device.txt');

      return c.json({ ok: true });
    }),
  );

  appRoutes.put('/api/me/connections/:provider', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const connectionsService = yield* ConnectionsService;

      const player = (yield* webSessionsService.require(c.get('sessionId'))).player_id;
      const name = Schema.decodeUnknownSync(provider)(c.req.param('provider'));
      const input = Schema.decodeUnknownSync(credentials)(yield* Effect.promise(() => c.req.json()));

      if (name === 'intervals') {
        Schema.decodeUnknownSync(IntervalsAthleteId)(input.username);
      }
      const secret = input.secret || (yield* connectionsService.inspect(player, name)).credentials?.[1];

      if (!secret) {
        throw new ApplicationError({ status: 400, message: 'Enter a secret.' });
      }
      yield* connectionsService.save(player, name, [input.username, secret]);

      return c.json({ ok: true });
    }),
  );
  appRoutes.put('/api/me/connections/strava/cookie', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const documentsService = yield* DocumentsService;

      const player = (yield* webSessionsService.require(c.get('sessionId'))).player_id;

      const input = Schema.decodeUnknownSync(
        Strict({
          cookie: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(10_000), Schema.isPattern(/^[^\r\n]+$/)),
        }),
      )(yield* Effect.promise(() => c.req.json()));

      yield* documentsService.put(player, 'strava4_session.txt', input.cookie);

      return c.json({ ok: true });
    }),
  );
  appRoutes.delete('/api/me/connections/:provider', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const uploadsService = yield* UploadsService;

      const connectionsService = yield* ConnectionsService;

      const player = (yield* webSessionsService.require(c.get('sessionId'))).player_id;
      const name = Schema.decodeUnknownSync(provider)(c.req.param('provider'));
      yield* connectionsService.remove(player, name);

      if (name === 'strava') {
        yield* uploadsService.disconnect(player, 'strava_token.txt');
        yield* uploadsService.disconnect(player, 'strava4_session.txt');
      } else if (name === 'garmin') {
        yield* uploadsService.disconnect(player, 'garth/oauth1_token.json');
      }

      return c.json({ ok: true });
    }),
  );
  // One stored credential, so a rider can drop the session cookie and keep the API, or the reverse.
  appRoutes.delete('/api/me/connections/:provider/:credential', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const uploadsService = yield* UploadsService;

      const connectionsService = yield* ConnectionsService;

      const player = (yield* webSessionsService.require(c.get('sessionId'))).player_id;
      const name = Schema.decodeUnknownSync(credential)(`${c.req.param('provider')}/${c.req.param('credential')}`);

      if (name === 'strava/api') {
        yield* connectionsService.remove(player, 'strava');
      } else if (name === 'garmin/credentials') {
        yield* connectionsService.remove(player, 'garmin');
      } else {
        yield* uploadsService.disconnect(player, tokens[name]);
      }

      return c.json({ ok: true });
    }),
  );
  appRoutes.post('/api/me/connections/garmin/authorize', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const integrationsService = yield* IntegrationsService;

      const id = c.get('sessionId');
      const user = yield* webSessionsService.require(id);
      const identity = runtime.effects.runSync(AccountsService).identityOf(user);

      const input = Schema.decodeUnknownSync(
        Strict({ code: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32))) }),
      )(yield* Effect.promise(() => c.req.json()));

      const status = yield* integrationsService
        .authorizeGarminSession(
          `web:${id}`,
          () => Effect.runSync(webSessionsService.current(id, identity)),
          user,
          input.code,
        )
        .pipe(asProviderFailure(runtime, 400, 'Garmin authorization failed or expired. Try again.'));

      return c.json({ status });
    }),
  );
  appRoutes.post('/api/me/connections/strava/authorize', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const connectionsService = yield* ConnectionsService;

      const integrationsService = yield* IntegrationsService;

      const id = c.get('sessionId');
      const user = yield* webSessionsService.require(id);
      const identity = runtime.effects.runSync(AccountsService).identityOf(user);

      const input = Schema.decodeUnknownSync(
        Strict({
          code: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000))),
          state: Schema.optional(Schema.String),
        }),
      )(yield* Effect.promise(() => c.req.json()));

      if (input.code) {
        const session = yield* webSessionsService.session(id);

        if (!session.stravaState || input.state !== session.stravaState) {
          throw new ApplicationError({ status: 403, message: 'Authorization expired.' });
        }
        delete session.stravaState;

        yield* integrationsService
          .authorizeStravaSession(() => Effect.runSync(webSessionsService.current(id, identity)), user, input.code)
          .pipe(asProviderFailure(runtime, 400, 'Strava authorization failed. Try again.'));

        return c.json({ ok: true });
      }

      const client = yield* connectionsService.read(user.player_id, 'strava');

      if (!client) {
        throw new ApplicationError({ status: 400, message: 'Save Strava API credentials first.' });
      }
      const redirect = new URL('/integrations', runtime.config.network.web.publicUrl ?? c.req.url).href;
      const state = yield* webSessionsService.token();
      (yield* webSessionsService.session(id)).stravaState = state;

      return c.json({ url: yield* integrationsService.authorizationUrl(client[0], state, redirect) });
    }),
  );
  appRoutes.post('/api/me/connections/strava/test', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const integrationsService = yield* IntegrationsService;

      const documentsService = yield* DocumentsService;

      const player = (yield* webSessionsService.require(c.get('sessionId'))).player_id;
      const cookie = (yield* documentsService.text(player, 'strava4_session.txt'))?.split(/\r?\n/, 1)[0];

      if (!cookie) {
        throw new ApplicationError({ status: 400, message: 'Save a session cookie first.' });
      }

      const valid = yield* integrationsService
        .checkSession(cookie, (fresh) =>
          runtime.effects.runSync(documentsService.put(player, 'strava4_session.txt', fresh)),
        )
        .pipe(asProviderFailure(runtime, 503, 'Could not reach Strava. Check your internet connection.'));

      return c.json({ valid });
    }),
  );
  appRoutes.post('/api/me/workouts/sync', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const workoutsService = yield* WorkoutsService;

      const filesService = yield* FilesService;

      const profilesService = yield* ProfilesService;

      const id = c.get('sessionId');
      const user = yield* webSessionsService.require(id);
      const identity = runtime.effects.runSync(AccountsService).identityOf(user);

      const input = Schema.decodeUnknownSync(Strict({ provider: Schema.Literals(['intervals', 'trainingpeaks']) }))(
        yield* Effect.promise(() => c.req.json()),
      );

      // The chosen provider becomes the one the game uses when both are configured.
      yield* filesService.write(
        resolve(yield* profilesService.folder(user.player_id), 'active_workout_provider.txt'),
        workoutProviders[input.provider],
        true,
      );

      const message = yield* workoutsService
        .sync(user.player_id)
        .pipe(asProviderFailure(runtime, 503, 'Workout sync failed. Existing workouts were retained.'));

      if (!(yield* webSessionsService.current(id, identity))) {
        throw new ApplicationError({ status: 401, message: 'Session changed.' });
      }

      return c.json({ message });
    }),
  );
  appRoutes.get('/api/me/uploads', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const uploadsService = yield* UploadsService;

      return c.json({
        jobs: (yield* uploadsService.status((yield* webSessionsService.require(c.get('sessionId'))).player_id)).slice(
          0,
          100,
        ),
      });
    }),
  );
  const activityId = NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0));
  appRoutes.get('/api/me/activities/:id/uploads', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const uploadsService = yield* UploadsService;

      return c.json({
        uploads: yield* uploadsService.forActivity(
          (yield* webSessionsService.require(c.get('sessionId'))).player_id,
          Schema.decodeUnknownSync(activityId)(c.req.param('id')),
        ),
      });
    }),
  );
  appRoutes.post('/api/me/activities/:id/uploads', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const uploadsService = yield* UploadsService;

      const player = (yield* webSessionsService.require(c.get('sessionId'))).player_id;
      const id = Schema.decodeUnknownSync(activityId)(c.req.param('id'));

      const input = Schema.decodeUnknownSync(
        Strict({ provider: Schema.Enum(UploadProvider), again: Schema.Boolean.pipe(withDefault(false)) }),
      )(yield* Effect.promise(() => c.req.json()));

      void (yield* uploadsService.request(player, id, input.provider, input.again));

      return c.json({ uploads: yield* uploadsService.forActivity(player, id) });
    }),
  );
  appRoutes.post('/api/me/uploads/retry', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const uploadsService = yield* UploadsService;

      const player = (yield* webSessionsService.require(c.get('sessionId'))).player_id;

      const input = Schema.decodeUnknownSync(Strict({ ambiguous: Schema.Boolean.pipe(withDefault(false)) }))(
        yield* Effect.promise(() => c.req.json()),
      );

      void (yield* uploadsService.retry(player, input.ambiguous));

      return c.json({ ok: true });
    }),
  );
}
