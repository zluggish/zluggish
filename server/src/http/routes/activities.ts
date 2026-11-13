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
import { Sport } from '#src/protocol/generated/profile_pb';
import { GhostSchema, WA_TYPE, WorldAttributeSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { course, worldTime } from '#src/world/state';
import { create, toBinary } from '@bufbuild/protobuf';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { randomBytes, timingSafeEqual } from 'node:crypto';
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

  const mediaTokens = new Map<string, { token: Buffer; expires: number }>();
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
            return service.recentActivities(id).map((row) => records.decode(ActivitySchema, row));
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
      runtime.world.logout(BigInt(user.player_id));

      return c.text('true');
    }

    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const activity = parseProtobuf(ActivitySchema, bytes);
    activity.playerId = BigInt(user.player_id);
    activity.id = id;
    records.update('activity', id, ActivitySchema, activity, ['fit']);

    if (c.req.query('upload-to-strava') === 'true') {
      if (activity.distanceInMeters < 1) service.deleteActivityById(id);
      else {
        const folder = runtime.services.profiles.folder(user.player_id);
        runtime.services.files.write(
          resolve(folder, 'fit', `${id} - ${filename(activity.fitFilename)}`),
          activity.fit,
          true,
        );
        runtime.services.files.write(resolve(folder, 'last_activity.bin'), bytes, true);

        if (activity.sport === Sport.CYCLING && activity.distanceInMeters >= 2000) {
          runtime.services.activities.updateStreaks(user.player_id, activity);
          runtime.world.enqueue(
            create(WorldAttributeSchema, {
              serverRealm: 1n,
              waType: WA_TYPE.PLAYER_FITNESS_METRICS_UPDATED,
              worldTimeBorn: worldTime(),
              worldTimeExpire: worldTime() + 60_000n,
              timestamp: BigInt(Date.now()) * 1000n,
            }),
            [BigInt(user.player_id)],
          );
        }

        try {
          runtime.services.activities.savePowerCurve(user.player_id, activity.fit);
        } catch {
          console.warn(`Power curve unavailable for activity ${id}`);
        }

        const history = runtime.world.histories.get(BigInt(user.player_id)) ?? [];

        const state = history.at(-1);

        const ghosts = runtime.services.settings.resolveRiderSettings(
          runtime.config.riderDefaults,
          runtime.services.settings.read(user.player_id),
        ).ghosts.enabled;

        if (ghosts && state && history.length > 0)
          runtime.services.files.write(
            resolve(
              folder,
              'ghosts',
              String(course(state)),
              ...(state.route
                ? [String(state.route)]
                : [String((state.aux3 >>> 8) & 0xff_ff), ...(state.f19 & 4 ? [] : ['reverse'])]),
              `${Date.now()}.bin`,
            ),
            toBinary(
              GhostSchema,
              create(GhostSchema, {
                playerId: user.player_id,
                states: history,
              }),
            ),
            true,
          );

        void uploads.run(user.player_id, activity, service.photos(user.player_id, id));
      }

      runtime.world.logout(BigInt(user.player_id));
    }

    return c.body(JSON.stringify({ id: Number(id) }), 200, {
      'Content-Type': 'text/html; charset=utf-8',
    });
  });

  app.get('/api/activities/:activityId', (c) => {
    authenticated(c);

    const row = service.activityById(c.req.param('activityId'));

    if (!row) throw new HTTPException(404);
    const activity = records.decode(ActivitySchema, row);
    const data = service.companion(activity, true);

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

    if (fileId !== null) {
      const chart = resolve(runtime.config.storageDir, 'activities', String(fileId));

      if (!runtime.services.files.exists(chart) && runtime.services.files.exists(fit)) {
        try {
          runtime.services.files.write(
            chart,
            JSON.stringify(runtime.services.activities.activityChart(runtime.services.files.read(fit))),
            true,
          );
        } catch {
          console.warn(`Chart unavailable for activity ${activity.id}`);
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
        .activityFeed(id, id, before ?? null, before ?? null, type === 'preview' ? 1 : 0, limit)
        .map((row) => records.decode(ActivitySchema, row));

      return c.json(activities.map((activity) => service.companion(activity)));
    },
  );
  app.get('/api/activities/:activityId/file/:fileId', (c) => {
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

    const id = service.insertActivityImage(user.player_id, c.req.param('activityId')).lastInsertRowid;

    const image = parseProtobuf(ActivityImageSchema, new Uint8Array(await c.req.arrayBuffer()));

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

    const id = service.insertActivityMedia(user.player_id, c.req.param('activityId'), body.contentType).lastInsertRowid;

    for (const [key, entry] of mediaTokens) if (entry.expires < Date.now()) mediaTokens.delete(key);
    const token = randomBytes(32);
    const expires = Date.now() + 900_000;
    mediaTokens.set(String(id), { token, expires });

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
    const entry = mediaTokens.get(c.req.param('id'));
    const token = Buffer.from(c.req.query('token') ?? '', 'base64url');

    if (
      !entry ||
      entry.expires < Date.now() ||
      token.length !== entry.token.length ||
      !timingSafeEqual(token, entry.token)
    )
      throw new HTTPException(403);

    const row = z
      .object({
        id: z.number(),
        player_id: z.number(),
        content_type: z.string(),
      })
      .safeParse(service.findActivityMedia(c.req.param('id')));

    if (!row.success) throw new HTTPException(404);

    const extension = row.data.content_type.includes('quicktime') ? 'mov' : 'mp4';

    runtime.services.files.write(
      resolve(runtime.services.profiles.folder(row.data.player_id), 'medias', `${row.data.id}.${extension}`),
      new Uint8Array(await c.req.arrayBuffer()),
      true,
    );
    mediaTokens.delete(c.req.param('id'));

    return c.body(null, 200);
  });
}
