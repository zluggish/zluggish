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
import { resolve } from 'node:path';
import { z } from 'zod';

function filename(value: string) {
  return (
    value
      .normalize('NFKD')
      .replaceAll(/[^\w. -]/g, '_')
      .replace(/^\.+/, '') || 'activity.fit'
  );
}

export function activityRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const service = runtime.services.activities;

  const records = runtime.services.recordData;

  const uploads = runtime.services.uploads;

  app.on(['GET', 'POST'], ['/api/profiles/:id/activities', '/api/profiles/:id/activities/'], async (c) => {
    const user = authenticated(c);
    const id = BigInt(c.req.param('id'));

    if (c.req.method === 'POST') {
      if (id !== BigInt(user.player_id)) throw new HTTPException(401);

      const activity = parseProtobuf(ActivitySchema, new Uint8Array(await c.req.arrayBuffer()));

      activity.playerId = id;

      if (!activity.date) activity.date = new Date().toISOString();

      const activityId = records.insert('activity', ActivitySchema, activity, ['fit']);

      return c.body(JSON.stringify({ id: Number(activityId) }), 200, {
        'Content-Type': 'text/html; charset=utf-8',
      });
    }

    return c.body(
      toBinary(
        ActivityListSchema,
        create(ActivityListSchema, {
          activities: (() => {
            return service
              .recentActivities(id, user.player_id)
              .map((row) => service.forViewer(records.decode(ActivitySchema, row), user.player_id));
          })(),
        }),
      ),
    );
  });

  app.on(['PUT', 'DELETE'], '/api/profiles/:id/activities/:activityId', async (c) => {
    const user = authenticated(c);
    const id = BigInt(c.req.param('activityId'));

    if (String(user.player_id) !== c.req.param('id')) throw new HTTPException(401);

    if (c.req.header('Source') === 'zwift-companion') throw new HTTPException(400);

    if (!service.findActivity(id, user.player_id)) throw new HTTPException(404);

    if (c.req.method === 'DELETE') {
      service.deleteActivity(id, user.player_id);
      runtime.world.logout(BigInt(user.player_id), 'activity_finished');

      return c.text('true');
    }

    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const activity = parseProtobuf(ActivitySchema, bytes);
    activity.playerId = BigInt(user.player_id);
    activity.id = id;

    const finish = c.req.query('upload-to-strava') === 'true';
    const outcome = service.save(activity, finish);

    if (outcome === 'completed') void uploads.drain();

    if (finish && outcome !== 'unchanged') runtime.world.logout(BigInt(user.player_id), 'activity_finished');

    return c.body(JSON.stringify({ id: Number(id) }), 200, {
      'Content-Type': 'text/html; charset=utf-8',
    });
  });

  app.get('/api/activities/:activityId', (c) => {
    const user = authenticated(c);

    const row = service.activityById(c.req.param('activityId'));

    if (!row) throw new HTTPException(404);
    const activity = service.forViewer(records.decode(ActivitySchema, row), user.player_id);

    if (!service.visible(activity, user.player_id)) throw new HTTPException(404);
    const fitness = service.fitnessVisible(activity, user.player_id);
    const data = service.companion(activity, fitness);

    const fit = resolve(
      runtime.services.profiles.folder(Number(activity.playerId)),
      'fit',
      `${activity.id} - ${filename(activity.fitFilename)}`,
    );

    const previous = service.findActivityFile(activity.id);

    const fileId = previous
      ? z.number().parse(previous.id)
      : runtime.services.files.exists(fit)
        ? Number(service.insertActivityFile(activity.id).lastInsertRowid)
        : null;

    if (fitness && fileId !== null) {
      const chart = resolve(runtime.config.storageDir, 'activities', String(fileId));

      if (!runtime.services.files.exists(chart) && runtime.services.files.exists(fit)) {
        try {
          runtime.services.files.write(
            chart,
            JSON.stringify(runtime.services.activities.activityChart(runtime.services.files.read(fit))),
            true,
          );
        } catch {
          runtime.world.lifecycle.log.warn('activity.chart_unavailable', 'Activity chart unavailable', {
            activityId: activity.id,
          });
        }
      }

      if (runtime.services.files.exists(chart)) {
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
    }

    return c.json(data);
  });
  app.on(
    'GET',
    [
      '/api/activity-feed-service-v2/feed/:feedType',
      '/api/activity-feed-service-v2/feed/:feedType/:profileId',
      '/api/activity-feed/feed/',
    ],
    (c) => {
      const user = authenticated(c);

      const type = c.req.param('feedType') ?? c.req.query('feedType')?.toLowerCase().replaceAll('_', '-');

      const limit = z.coerce
        .number()
        .int()
        .min(0)
        .max(1000)
        .parse(c.req.query('limit') ?? 50);

      const id =
        type === 'just-me' ? user.player_id : Number(c.req.param('profileId') ?? c.req.query('profile_id')) || null;

      const before = c.req.query('start_after_activity_id');

      const activities = service
        .activityFeed(id, before ?? null, type === 'preview' ? 1 : 0, user.player_id, limit)
        .map((row) => service.forViewer(records.decode(ActivitySchema, row), user.player_id));

      return c.json(activities.map((activity) => service.companion(activity)));
    },
  );
  app.get('/api/activities/:activityId/file/:fileId', (c) => {
    const user = authenticated(c);
    const activity = service.activityById(c.req.param('activityId'));

    if (!activity || !service.fitnessVisible(records.decode(ActivitySchema, activity), user.player_id))
      throw new HTTPException(404);
    const id = z.coerce.number().int().positive().safe().parse(c.req.param('fileId'));

    if (!service.findOwnedActivityFile(id, c.req.param('activityId'))) throw new HTTPException(404);
    const file = resolve(runtime.config.storageDir, 'activities', String(id));

    if (!runtime.services.files.exists(file)) throw new HTTPException(404);

    return c.body(runtime.services.files.read(file), 200, {
      'Content-Type': 'application/json',
    });
  });
  app.post('/api/profiles/:id/activities/:activityId/images', async (c) => {
    const user = authenticated(c);

    if (String(user.player_id) !== c.req.param('id')) throw new HTTPException(401);

    const image = parseProtobuf(ActivityImageSchema, new Uint8Array(await c.req.arrayBuffer()));

    if (!service.findActivity(c.req.param('activityId'), user.player_id)) throw new HTTPException(404);
    const id = service.insertActivityImage(user.player_id, c.req.param('activityId')).lastInsertRowid;

    runtime.services.files.write(
      resolve(runtime.services.profiles.folder(user.player_id), 'images', `${id}.jpg`),
      image.jpg,
      true,
    );

    return c.json({ id: Number(id), id_str: String(id) });
  });
  app.post('/api/profiles/:id/activities/:activityId/medias', async (c) => {
    const user = authenticated(c);

    if (String(user.player_id) !== c.req.param('id')) throw new HTTPException(401);

    const body = parseProtobuf(ActivityMediaSaveRequestSchema, new Uint8Array(await c.req.arrayBuffer()));

    if (!service.findActivity(c.req.param('activityId'), user.player_id)) throw new HTTPException(404);
    const id = service.insertActivityMedia(user.player_id, c.req.param('activityId'), body.contentType).lastInsertRowid;

    const { token, expires } = service.issueMedia(String(id));

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
  });
  app.put('/uploads/media/:id', async (c) => {
    await service.receiveMedia(c.req.param('id'), Buffer.from(c.req.query('token') ?? '', 'base64url'), () =>
      c.req.arrayBuffer(),
    );

    return c.body(null, 200);
  });
}
