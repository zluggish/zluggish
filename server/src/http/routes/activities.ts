import { AccountsService } from '#src/services/auth.service';
import { RideCompletionService } from '#src/services/ride-completion.service';
import { ActivitiesService } from '#src/services/activities.service';
import { FilesService } from '#src/services/files.service';
import { effectRoutes } from '#src/http/effect';
import { RecordDataService } from '#src/services/record-data.service';
import { parseProtobuf } from '#src/http/protobuf';
import { authenticated } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import {
  ActivityImageSchema,
  ActivityListSchema,
  ActivityMediaSaveRequestSchema,
  ActivityMediaSaveResultSchema,
  ActivitySchema,
} from '#src/protocol/generated/activity_pb';
import { create, toBinary } from '@bufbuild/protobuf';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { Effect, Schema } from 'effect';
import { NumberFromInput } from '#src/schema';

export function activityRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const appRoutes = effectRoutes(app, runtime);
  appRoutes.on(['GET', 'POST'], ['/api/profiles/:id/activities', '/api/profiles/:id/activities/'], (c) =>
    Effect.gen(function* () {
      const rideCompletionService = yield* RideCompletionService;

      const activitiesService = yield* ActivitiesService;

      const recordDataService = yield* RecordDataService;

      const user = authenticated(c);
      const id = BigInt(c.req.param('id'));

      if (c.req.method === 'POST') {
        if (id !== BigInt(user.player_id)) {
          throw new HTTPException(401);
        }

        const activity = parseProtobuf(
          ActivitySchema,
          new Uint8Array(yield* Effect.promise(() => c.req.arrayBuffer())),
        );

        if (
          !runtime.effects.runSync(AccountsService).identity(runtime.effects.runSync(AccountsService).identityOf(user))
        ) {
          throw new HTTPException(401);
        }
        activity.playerId = id;

        if (!activity.date) {
          activity.date = new Date().toISOString();
        }

        const activityId = yield* recordDataService.insert('activity', ActivitySchema, activity, ['fit']);
        // Fix the activity folder name from the start date the client sent first.
        yield* activitiesService.folder(activityId);
        yield* rideCompletionService.register(user.player_id, BigInt(activityId), c.req.header('Authorization') ?? '');

        return c.body(JSON.stringify({ id: Number(activityId) }), 200, {
          'Content-Type': 'text/html; charset=utf-8',
        });
      }

      return c.body(
        toBinary(
          ActivityListSchema,
          create(ActivityListSchema, {
            activities: yield* Effect.forEach(yield* activitiesService.recentActivities(id, user.player_id), (row) =>
              recordDataService
                .decode(ActivitySchema, row)
                .pipe(Effect.map((activity) => ActivitiesService.forViewer(activity, user.player_id))),
            ),
          }),
        ),
      );
    }),
  );

  appRoutes.on(['PUT', 'DELETE'], '/api/profiles/:id/activities/:activityId', (c) =>
    Effect.gen(function* () {
      const activitiesService = yield* ActivitiesService;

      const user = authenticated(c);
      const id = BigInt(c.req.param('activityId'));

      if (String(user.player_id) !== c.req.param('id')) {
        throw new HTTPException(401);
      }

      if (c.req.header('Source') === 'zwift-companion') {
        throw new HTTPException(400);
      }

      if (!(yield* activitiesService.findActivity(id, user.player_id))) {
        throw new HTTPException(404);
      }

      if (c.req.method === 'DELETE') {
        yield* activitiesService.deleteActivity(id, user.player_id);
        runtime.world.logout(BigInt(user.player_id), 'activity_finished');

        return c.text('true');
      }

      const bytes = new Uint8Array(yield* Effect.promise(() => c.req.arrayBuffer()));
      const activity = parseProtobuf(ActivitySchema, bytes);
      activity.playerId = BigInt(user.player_id);
      activity.id = id;

      const finish = c.req.query('upload-to-strava') === 'true';

      const outcome = yield* activitiesService.saveInTurn(activity, finish, () => {
        if (
          !runtime.effects.runSync(AccountsService).identity(runtime.effects.runSync(AccountsService).identityOf(user))
        ) {
          throw new HTTPException(401);
        }
      });

      if (finish && outcome !== 'unchanged') {
        runtime.world.logout(BigInt(user.player_id), 'activity_finished');
      }

      return c.body(JSON.stringify({ id: Number(id) }), 200, {
        'Content-Type': 'text/html; charset=utf-8',
      });
    }),
  );

  appRoutes.get('/api/activities/:activityId', (c) =>
    Effect.gen(function* () {
      const activitiesService = yield* ActivitiesService;

      const recordDataService = yield* RecordDataService;

      const user = authenticated(c);

      const row = yield* activitiesService.activityById(c.req.param('activityId'));

      if (!row) {
        throw new HTTPException(404);
      }

      const activity = yield* activitiesService.forViewer(
        yield* recordDataService.decode(ActivitySchema, row),
        user.player_id,
      );

      if (!(yield* activitiesService.visible(activity, user.player_id))) {
        throw new HTTPException(404);
      }
      const fitness = yield* activitiesService.fitnessVisible(activity, user.player_id);
      const data = yield* activitiesService.companion(activity, fitness);

      // Charts come from the canonical FIT payload. A missing chart is created by a job;
      // the details omit fitness data until it is ready.
      const fileId = fitness ? yield* activitiesService.chartFile(activity.id) : null;

      if (fileId !== null) {
        const url = `https://us-or-rly101.zwift.com/api/activities/${activity.id}/file/${fileId}`;

        return c.json({
          ...data,
          fitnessData: {
            status: 'AVAILABLE',
            fullDataUrl: url,
            smallDataUrl: url,
          },
        });
      }

      return c.json(data);
    }),
  );
  appRoutes.on(
    'GET',
    [
      '/api/activity-feed-service-v2/feed/:feedType',
      '/api/activity-feed-service-v2/feed/:feedType/:profileId',
      '/api/activity-feed/feed/',
    ],
    (c) =>
      Effect.gen(function* () {
        const activitiesService = yield* ActivitiesService;

        const recordDataService = yield* RecordDataService;

        const user = authenticated(c);

        const type = c.req.param('feedType') ?? c.req.query('feedType')?.toLowerCase().replaceAll('_', '-');

        const limit = Schema.decodeUnknownSync(
          NumberFromInput.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1000)),
        )(c.req.query('limit') ?? 50);

        const id =
          type === 'just-me' ? user.player_id : Number(c.req.param('profileId') ?? c.req.query('profile_id')) || null;

        const before = c.req.query('start_after_activity_id');

        const activities = yield* Effect.forEach(
          yield* activitiesService.activityFeed(id, before ?? null, type === 'preview' ? 1 : 0, user.player_id, limit),
          (row) =>
            recordDataService
              .decode(ActivitySchema, row)
              .pipe(Effect.map((activity) => ActivitiesService.forViewer(activity, user.player_id))),
        );

        return c.json(yield* Effect.forEach(activities, (activity) => activitiesService.companion(activity)));
      }),
  );
  appRoutes.get('/api/activities/:activityId/file/:fileId', (c) =>
    Effect.gen(function* () {
      const activitiesService = yield* ActivitiesService;

      const filesService = yield* FilesService;

      const recordDataService = yield* RecordDataService;

      const user = authenticated(c);
      const activity = yield* activitiesService.activityById(c.req.param('activityId'));

      if (
        !activity ||
        !(yield* activitiesService.fitnessVisible(
          yield* recordDataService.decode(ActivitySchema, activity),
          user.player_id,
        ))
      ) {
        throw new HTTPException(404);
      }

      const id = Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(
        c.req.param('fileId'),
      );

      if (!(yield* activitiesService.findOwnedActivityFile(id, c.req.param('activityId')))) {
        throw new HTTPException(404);
      }
      const file = yield* activitiesService.chartPath(c.req.param('activityId'));

      if (file === null || !(yield* filesService.exists(file))) {
        throw new HTTPException(404);
      }

      return c.body(yield* filesService.read(file), 200, {
        'Content-Type': 'application/json',
      });
    }),
  );
  appRoutes.post('/api/profiles/:id/activities/:activityId/images', (c) =>
    Effect.gen(function* () {
      const activitiesService = yield* ActivitiesService;

      const user = authenticated(c);

      if (String(user.player_id) !== c.req.param('id')) {
        throw new HTTPException(401);
      }

      const image = parseProtobuf(
        ActivityImageSchema,
        new Uint8Array(yield* Effect.promise(() => c.req.arrayBuffer())),
      );

      if (!(yield* activitiesService.findActivity(c.req.param('activityId'), user.player_id))) {
        throw new HTTPException(404);
      }
      const id = yield* activitiesService.saveImage(user.player_id, c.req.param('activityId'), image.jpg);

      return c.json({ id, id_str: String(id) });
    }),
  );
  appRoutes.post('/api/profiles/:id/activities/:activityId/medias', (c) =>
    Effect.gen(function* () {
      const activitiesService = yield* ActivitiesService;

      const user = authenticated(c);

      if (String(user.player_id) !== c.req.param('id')) {
        throw new HTTPException(401);
      }

      const body = parseProtobuf(
        ActivityMediaSaveRequestSchema,
        new Uint8Array(yield* Effect.promise(() => c.req.arrayBuffer())),
      );

      if (!(yield* activitiesService.findActivity(c.req.param('activityId'), user.player_id))) {
        throw new HTTPException(404);
      }

      const id = (yield* activitiesService.insertActivityMedia(
        user.player_id,
        c.req.param('activityId'),
        body.contentType,
      )).lastInsertRowid;

      const { token, expires } = yield* activitiesService.issueMedia(String(id));

      return c.body(
        toBinary(
          ActivityMediaSaveResultSchema,
          create(ActivityMediaSaveResultSchema, {
            uploadUrl: `https://us-or-rly101.zwift.com/uploads/media/${id}?token=${token.toString('base64url')}`,
            expirationInMillis: BigInt(expires),
            signedHeaders: { 'Content-Type': { values: [body.contentType] } },
          }),
        ),
      );
    }),
  );
  appRoutes.put('/uploads/media/:id', (c) =>
    Effect.gen(function* () {
      const activitiesService = yield* ActivitiesService;

      yield* activitiesService.receiveMedia(
        c.req.param('id'),
        Buffer.from(c.req.query('token') ?? '', 'base64url'),
        () => c.req.arrayBuffer(),
      );

      return c.body(null, 200);
    }),
  );
}
