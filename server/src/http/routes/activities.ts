import { parseProtobuf } from '#src/http/protobuf';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { create, toBinary } from '@bufbuild/protobuf';
import type { Activity } from '#src/protocol/generated/activity_pb';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { resolve } from 'node:path';
import {
  ActivitySchema,
  ActivityListSchema,
  ActivityImageSchema,
  ActivityMediaSaveRequestSchema,
  ActivityMediaSaveResultSchema,
} from '#src/protocol/generated/activity_pb';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { GhostSchema, WorldAttributeSchema, WA_TYPE } from '#src/protocol/generated/udp-node-msgs_pb';
import { Sport } from '#src/protocol/generated/profile_pb';
import { ActivityUploads } from '#src/node/integrations/uploads';
import { resolveRiderSettings } from '#src/node/persistence/settings';
import { ProtobufRows } from '#src/node/persistence/protobuf';
import { writeDurable } from '#src/node/persistence/files';
import { authenticated } from '#src/http/routes/accounts';
import type { Runtime, RuntimeEnv } from '#src/http/runtime';
import { course, worldTime } from '#src/world/state';
import { activityChart, savePowerCurve } from '#src/domain/activities/fit';
import { updateStreaks } from '#src/domain/activities/streaks';

function filename(value: string) {
  return (
    value
      .normalize('NFKD')
      .replaceAll(/[^\w. -]/g, '_')
      .replace(/^\.+/, '') || 'activity.fit'
  );
}

export function activityRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const records = new ProtobufRows(runtime.accounts.db);
  const db = runtime.accounts.db;
  const mediaTokens = new Map<string, { token: Buffer; expires: number }>();
  const uploads = new ActivityUploads(runtime);

  function photos(player: number, activity: bigint) {
    const folder = runtime.profiles.folder(player);

    const images = z
      .array(z.object({ id: z.number() }))
      .parse(db.prepare('SELECT id FROM activity_image WHERE player_id=? AND activity_id=?').all(player, activity))
      .map((row) => resolve(folder, 'images', `${row.id}.jpg`));

    const media = z
      .array(z.object({ id: z.number(), content_type: z.string() }))
      .parse(
        db
          .prepare('SELECT id, content_type FROM activity_media WHERE player_id=? AND activity_id=?')
          .all(player, activity),
      )
      .map((row) => resolve(folder, 'medias', `${row.id}.${row.content_type.includes('quicktime') ? 'mov' : 'mp4'}`));

    return [...images, ...media].filter((path) => existsSync(path));
  }

  function companion(activity: Activity, details = false) {
    const profile = runtime.profiles.get(Number(activity.playerId));

    const moving = Date.parse(activity.endDate) - Date.parse(activity.startDate);

    const summary = {
      id: Number(activity.id),
      profile: {
        id: String(activity.playerId),
        firstName: profile.firstName,
        lastName: profile.lastName,
        imageSrc: profile.largeAvatarUrl || null,
        approvalRequired: null,
      },
      worldId: Number(activity.courseId),
      name: activity.name,
      sport: activity.sport === 1 ? 'RUNNING' : 'CYCLING',
      startDate: activity.startDate,
      endDate: activity.endDate,
      distanceInMeters: activity.distanceInMeters,
      totalElevation: activity.totalElevation,
      calories: activity.calories,
      primaryImageUrl: '',
      feedImageThumbnailUrl: '',
      lastSaveDate: activity.date,
      movingTimeInMs: Number.isFinite(moving) ? moving : 0,
      avgSpeedInMetersPerSecond: activity.avgSpeed,
      activityRideOnCount: 0,
      activityCommentCount: 0,
      privacy: 'PUBLIC',
      eventId: null,
      rideOnGiven: false,
      id_str: String(activity.id),
    };

    return details
      ? {
          ...summary,
          avgWatts: activity.avgWatts,
          maxWatts: activity.maxWatts,
          avgHeartRate: activity.avgHeartRate,
          maxHeartRate: activity.maxHeartRate,
          avgCadenceInRotationsPerMinute: activity.avgCadence,
          maxCadenceInRotationsPerMinute: activity.maxCadence,
          maxSpeedInMetersPerSecond: activity.maxSpeed,
        }
      : summary;
  }

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
          activities: records.select('activity', ActivitySchema, id),
        }),
      ),
    );
  });

  app.on(['PUT', 'DELETE'], '/api/profiles/:id/activities/:activityId', async (c) => {
    const user = authenticated(c);
    const id = BigInt(c.req.param('activityId'));

    if (String(user.player_id) !== c.req.param('id')) throw new HTTPException(401);

    if (c.req.header('Source') === 'zwift-companion') throw new HTTPException(400);
    const db = runtime.accounts.db;

    if (!db.prepare('SELECT id FROM activity WHERE id=? AND player_id=?').get(id, user.player_id))
      throw new HTTPException(404);

    if (c.req.method === 'DELETE') {
      db.prepare('DELETE FROM activity WHERE id=? AND player_id=?').run(id, user.player_id);
      runtime.world.logout(BigInt(user.player_id));

      return c.text('true');
    }

    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const activity = parseProtobuf(ActivitySchema, bytes);
    activity.playerId = BigInt(user.player_id);
    activity.id = id;
    records.update('activity', id, ActivitySchema, activity, ['fit']);

    if (c.req.query('upload-to-strava') === 'true') {
      if (activity.distanceInMeters < 1) db.prepare('DELETE FROM activity WHERE id=?').run(id);
      else {
        const folder = runtime.profiles.folder(user.player_id);
        writeDurable(resolve(folder, 'fit', `${id} - ${filename(activity.fitFilename)}`), activity.fit, true);
        writeDurable(resolve(folder, 'last_activity.bin'), bytes, true);

        if (activity.sport === Sport.CYCLING && activity.distanceInMeters >= 2000) {
          updateStreaks(runtime.profiles, user.player_id, activity);
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
          savePowerCurve(runtime.accounts, runtime.profiles, user.player_id, activity.fit);
        } catch {
          console.warn(`Power curve unavailable for activity ${id}`);
        }

        const history = runtime.world.histories.get(BigInt(user.player_id)) ?? [];

        const state = history.at(-1);

        const ghosts = resolveRiderSettings(runtime.config.riderDefaults, runtime.settings.read(user.player_id)).ghosts
          .enabled;

        if (ghosts && state && history.length > 0)
          writeDurable(
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

        // Uploads run detached so a slow service never holds the client.
        void uploads.run(user.player_id, activity, photos(user.player_id, id));
      }

      runtime.world.logout(BigInt(user.player_id));
    }

    return c.body(JSON.stringify({ id: Number(id) }), 200, {
      'Content-Type': 'text/html; charset=utf-8',
    });
  });

  app.get('/api/activities/:activityId', (c) => {
    authenticated(c);
    const query = db.prepare('SELECT * FROM activity WHERE id=?');
    query.setReadBigInts(true);
    const row = query.get(c.req.param('activityId'));

    if (!row) throw new HTTPException(404);
    const activity = records.decode(ActivitySchema, row);
    const data = companion(activity, true);

    const fit = resolve(
      runtime.profiles.folder(Number(activity.playerId)),
      'fit',
      `${activity.id} - ${filename(activity.fitFilename)}`,
    );

    const previous = db.prepare('SELECT id FROM activity_file WHERE activity_id=? AND full=0').get(activity.id);

    const fileId = previous
      ? z.number().parse(previous.id)
      : existsSync(fit)
        ? Number(
            db.prepare('INSERT INTO activity_file (activity_id,full) VALUES (?,0)').run(activity.id).lastInsertRowid,
          )
        : null;

    if (fileId !== null) {
      const chart = resolve(runtime.config.storageDir, 'activities', String(fileId));

      if (!existsSync(chart) && existsSync(fit)) {
        try {
          writeDurable(chart, JSON.stringify(activityChart(readFileSync(fit))), true);
        } catch {
          console.warn(`Chart unavailable for activity ${activity.id}`);
        }
      }

      if (existsSync(chart)) {
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

      const query = db.prepare(
        'SELECT * FROM activity WHERE distanceInMeters>1 AND (? IS NULL OR player_id=?) AND (? IS NULL OR id<?) AND (? OR end_date IS NOT NULL) ORDER BY date DESC LIMIT ?',
      );

      query.setReadBigInts(true);

      const activities = query
        .all(id, id, before ?? null, before ?? null, type === 'preview' ? 1 : 0, limit)
        .map((row) => records.decode(ActivitySchema, row));

      return c.json(activities.map((activity) => companion(activity)));
    },
  );
  app.get('/api/activities/:activityId/file/:fileId', (c) => {
    const id = z.coerce.number().int().positive().safe().parse(c.req.param('fileId'));

    if (!db.prepare('SELECT id FROM activity_file WHERE id=? AND activity_id=?').get(id, c.req.param('activityId')))
      throw new HTTPException(404);
    const file = resolve(runtime.config.storageDir, 'activities', String(id));

    if (!existsSync(file)) throw new HTTPException(404);

    return c.body(readFileSync(file), 200, {
      'Content-Type': 'application/json',
    });
  });
  app.post('/api/profiles/:id/activities/:activityId/images', async (c) => {
    const user = authenticated(c);

    if (String(user.player_id) !== c.req.param('id')) throw new HTTPException(401);

    const id = db
      .prepare('INSERT INTO activity_image (player_id,activity_id) VALUES (?,?)')
      .run(user.player_id, c.req.param('activityId')).lastInsertRowid;

    const image = parseProtobuf(ActivityImageSchema, new Uint8Array(await c.req.arrayBuffer()));

    writeDurable(resolve(runtime.profiles.folder(user.player_id), 'images', `${id}.jpg`), image.jpg, true);

    return c.json({ id: Number(id), id_str: String(id) });
  });
  app.post('/api/profiles/:id/activities/:activityId/medias', async (c) => {
    const user = authenticated(c);

    if (String(user.player_id) !== c.req.param('id')) throw new HTTPException(401);

    const body = parseProtobuf(ActivityMediaSaveRequestSchema, new Uint8Array(await c.req.arrayBuffer()));

    const id = db
      .prepare('INSERT INTO activity_media (player_id,activity_id,content_type) VALUES (?,?,?)')
      .run(user.player_id, c.req.param('activityId'), body.contentType).lastInsertRowid;

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
      .safeParse(db.prepare('SELECT * FROM activity_media WHERE id=?').get(c.req.param('id')));

    if (!row.success) throw new HTTPException(404);

    const extension = row.data.content_type.includes('quicktime') ? 'mov' : 'mp4';

    writeDurable(
      resolve(runtime.profiles.folder(row.data.player_id), 'medias', `${row.data.id}.${extension}`),
      new Uint8Array(await c.req.arrayBuffer()),
      true,
    );
    mediaTokens.delete(c.req.param('id'));

    return c.body(null, 200);
  });
}
