import { t } from '#src/i18n/index';
import { SessionsService } from '#src/services/browser-session.service';
import { Effect, Option, Schema } from 'effect';
import { ActivitiesService } from '#src/services/activities.service';
import { RideCompletionService } from '#src/services/ride-completion.service';
import type { Hono } from 'hono';
import type { HttpRuntime, RuntimeEnv } from '#src/http/runtime';
import { ApplicationError } from '#src/errors';
import { parseProtobuf } from '#src/http/protobuf';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';

/** Only these native requests may use a completion permission. They never set rider context. */
export function rideCompletionRoutes(app: Hono<RuntimeEnv>, runtime: HttpRuntime) {
  app.on(['PUT', 'DELETE'], '/api/profiles/:id/activities/:activityId', (c, next) =>
    runtime.effects.runPromise(
      Effect.gen(function* () {
        const completion = yield* RideCompletionService;
        const activities = yield* ActivitiesService;
        const bearer = c.req.header('Authorization') ?? '';

        if (!bearer || runtime.effects.runSync(SessionsService).bearer(bearer.replace(/^Bearer /i, ''))) {
          return yield* Effect.promise(() => next());
        }

        const ids = Schema.decodeUnknownOption(
          Schema.Struct({
            id: Schema.String.check(Schema.isPattern(/^\d{1,10}$/)),
            activityId: Schema.String.check(Schema.isPattern(/^\d{1,19}$/)),
          }),
        )(c.req.param());

        if (Option.isNone(ids)) {
          throw new ApplicationError({ status: 400, message: t('invalid_ride_identity') });
        }
        const player = Number(ids.value.id);
        const activityId = BigInt(ids.value.activityId);
        const bytes = new Uint8Array(yield* Effect.promise(() => c.req.arrayBuffer()));
        const permitted = yield* completion.authorize(player, activityId, bearer, bytes);

        if (permitted.receipt !== null && (c.req.method !== 'PUT' || c.req.query('upload-to-strava') !== 'true')) {
          throw new ApplicationError({ status: 401, message: t('final_save_retry_only') });
        }

        if (permitted.receipt !== null) {
          return c.body(permitted.receipt, 200, { 'Content-Type': 'text/html; charset=utf-8' });
        }

        if (c.req.header('Source') === 'zwift-companion') {
          throw new ApplicationError({ status: 403, message: t('native_ride_saves_only') });
        }

        if (c.req.method === 'DELETE') {
          yield* activities.deleteActivity(activityId, player);
          yield* completion.cancel(player);

          return c.text('true');
        }

        const activity = parseProtobuf(ActivitySchema, bytes);

        if (activity.playerId !== BigInt(player) || activity.id !== activityId) {
          throw new ApplicationError({ status: 403, message: t('ride_completion_ride_identity_mismatch') });
        }
        const finish = c.req.query('upload-to-strava') === 'true';
        yield* activities.saveInTurn(
          activity,
          finish,
          () => Effect.runSync(completion.authorize(player, activityId, bearer, bytes)).receipt === null,
        );
        const result = JSON.stringify({ id: Number(activityId) });

        if (finish) {
          yield* completion.finish(player, activityId, bearer, bytes, result);
        } else {
          yield* completion.touch(player);
        }

        return c.body(result, 200, { 'Content-Type': 'text/html; charset=utf-8' });
      }),
    ),
  );
}
