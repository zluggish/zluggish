import { parseProtobuf } from '#src/http/protobuf';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { create, toBinary } from '@bufbuild/protobuf';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PlayerProfilesSchema, PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import {
  RideOnSchema,
  WorldAttributeSchema,
  ServerToClientSchema,
  WA_TYPE,
} from '#src/protocol/generated/udp-node-msgs_pb';
import { SocialPlayerActionSchema, SocialPlayerActionType } from '#src/protocol/generated/tcp-node-msgs_pb';
import { PlaybackDataSchema, PlaybackMetadataSchema } from '#src/protocol/generated/playback_pb';
import { writeDurable } from '#src/node/persistence/files';
import type { Runtime, RuntimeEnv } from '#src/http/runtime';
import { authenticated } from '#src/http/routes/accounts';
import { worldTime, course } from '#src/world/state';

export function sendMessage(runtime: Runtime, message: string, recipients?: bigint[], sender = 'Server') {
  if (sender === 'Server' && recipients === undefined) runtime.discord?.send(message);
  runtime.world.enqueue(
    create(WorldAttributeSchema, {
      serverRealm: 1n,
      waType: WA_TYPE.WAT_SPA,
      worldTimeBorn: worldTime(),
      worldTimeExpire: worldTime() + 60_000n,
      waF12: 1n,
      timestamp: BigInt(Date.now()) * 1000n,
      payload: toBinary(
        SocialPlayerActionSchema,
        create(SocialPlayerActionSchema, {
          playerId: 0n,
          toPlayerId: 0n,
          spaType: SocialPlayerActionType.SOCIAL_TEXT_MESSAGE,
          firstName: sender,
          lastName: '',
          message,
          countryCode: 0,
        }),
      ),
    }),
    recipients,
  );
}

export function socialRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const db = runtime.accounts.db;

  const summary = (id: number) => {
    const profile = runtime.profiles.get(id);

    const image = existsSync(resolve(runtime.profiles.folder(id), 'avatarLarge.jpg'))
      ? `https://us-or-rly101.zwift.com/download/${id}/avatarLarge.jpg`
      : null;

    return {
      id,
      firstName: profile.firstName,
      lastName: profile.lastName,
      imageSrc: image,
      imageSrcLarge: image,
      countryCode: profile.countryCode,
    };
  };

  app.get('/api/profiles', (c) => {
    const ids = z
      .array(z.coerce.number().int().positive().safe())
      .max(1000)
      .parse(c.req.queries('id') ?? []);

    return c.body(
      toBinary(
        PlayerProfilesSchema,
        create(PlayerProfilesSchema, {
          profiles: ids.map((id) => {
            if (runtime.profiles.synthetic.has(BigInt(id)) || runtime.accounts.get(id)) return runtime.profiles.get(id);

            return create(PlayerProfileSchema, {
              id: BigInt(id),
              lastName: id > 9_000_000 && id < 10_000_000 ? 'Bookmark' : '',
            });
          }),
        }),
      ),
    );
  });
  app.on(
    'GET',
    ['/api/profiles/:id/followers', '/api/profiles/:id/followees', '/api/profiles/:id/followees-in-common/:other'],
    (c) => {
      authenticated(c);

      if (c.req.header('Accept') === 'application/x-protobuf-lite') return c.body(null, 200);

      return c.json(
        runtime.accounts.list().map((user) => ({
          id: 0,
          followerId: user.player_id,
          followeeId: Number(c.req.param('id')),
          status: 'IS_FOLLOWING',
          isFolloweeFavoriteOfFollower: true,
          followerProfile: summary(user.player_id),
          followeeProfile: null,
        })),
      );
    },
  );
  app.on('POST', ['/api/search/profiles', '/api/search/profiles/restricted'], async (c) => {
    authenticated(c);
    const input = z.object({ query: z.string() }).parse(await c.req.json());

    const start = z.coerce
      .number()
      .int()
      .min(0)
      .parse(c.req.query('start') ?? 0);

    const limit = z.coerce
      .number()
      .int()
      .min(0)
      .max(1000)
      .parse(c.req.query('limit') ?? 100);

    const rows = db
      .prepare('SELECT player_id FROM user WHERE first_name LIKE ? OR last_name LIKE ? LIMIT ? OFFSET ?')
      .all(`%${input.query}%`, `%${input.query}%`, limit, start);

    return c.json(rows.map((row) => summary(z.number().parse(row.player_id))));
  });
  app.post('/api/profiles/:id/privacy', async (c) => {
    const user = authenticated(c);

    if (String(user.player_id) !== c.req.param('id')) throw new HTTPException(401);

    const input = z
      .object({
        approvalRequired: z.boolean(),
        displayWeight: z.boolean().default(false),
        minor: z.boolean().default(false),
        privateMessaging: z.boolean(),
        defaultFitnessDataPrivacy: z.boolean(),
        suppressFollowerNotification: z.boolean().default(false),
        displayAge: z.boolean(),
        defaultActivityPrivacy: z.enum(['PUBLIC', 'PRIVATE', 'FRIENDS']),
      })
      .parse(await c.req.json());

    const profile = runtime.profiles.get(user.player_id);
    profile.privacyBits = BigInt(
      (input.approvalRequired ? 1 : 0) +
        (input.minor ? 2 : 0) +
        (input.displayWeight ? 4 : 0) +
        (input.privateMessaging ? 8 : 0) +
        (input.defaultFitnessDataPrivacy ? 16 : 0) +
        (input.suppressFollowerNotification ? 32 : 0) +
        (input.displayAge ? 0 : 64),
    );
    profile.defaultActivityPrivacy =
      input.defaultActivityPrivacy === 'PRIVATE' ? 1 : input.defaultActivityPrivacy === 'FRIENDS' ? 2 : 0;
    runtime.profiles.save(user.player_id, profile);
    writeDurable(resolve(runtime.profiles.folder(user.player_id), 'privacy.json'), JSON.stringify(input), true);

    return c.body(null, 200);
  });
  app.get('/api/profiles/:id/statistics', (c) => {
    const row = db
      .prepare(
        'SELECT SUM(CAST((julianday(date)-julianday(start_date))*1440 AS INTEGER)) AS timeRiddenInMinutes, SUM(distanceInMeters) AS distanceRiddenInMeters, SUM(calories) AS caloriesBurned, SUM(total_elevation) AS heightClimbedInMeters FROM activity WHERE player_id=? AND julianday(start_date)>=julianday(?)',
      )
      .get(c.req.param('id'), c.req.query('startDateTime') ?? '1970-01-01');

    return c.json(z.record(z.string(), z.number().nullable()).parse(row));
  });
  app.post('/api/profiles/:id/photo', async (c) => {
    const user = authenticated(c);

    if (String(user.player_id) !== c.req.param('id')) throw new HTTPException(401);
    let image: Uint8Array;

    if (c.req.header('Content-Type')?.toLowerCase().startsWith('multipart/form-data')) {
      let form: FormData;

      try {
        form = await c.req.formData();
      } catch {
        throw new HTTPException(400);
      }

      const file = form.values().find((value) => value instanceof File);

      if (!(file instanceof File)) throw new HTTPException(400);
      image = new Uint8Array(await file.arrayBuffer());
    } else image = new Uint8Array(await c.req.arrayBuffer());

    if (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8 || image.at(-2) !== 0xff || image.at(-1) !== 0xd9)
      throw new HTTPException(400);
    writeDurable(resolve(runtime.profiles.folder(user.player_id), 'avatarLarge.jpg'), image, true);

    return c.body(null, 200);
  });
  app.put('/relay/profiles/me/phone', async (c) => {
    const user = authenticated(c);

    const input = z
      .object({
        phoneAddress: z.string().max(255),
        port: z.number().int().min(1).max(65_535).optional(),
        securePort: z.number().int().min(1).max(65_535).optional(),
        secret: z.string().optional(),
      })
      .parse(await c.req.json());

    const port = input.securePort ?? input.port;

    if (!port || (input.securePort && !input.secret)) throw new HTTPException(400);

    const message = create(ServerToClientSchema, {
      playerId: BigInt(user.player_id),
      worldTime: 0n,
      zcLocalIp: input.phoneAddress,
      zcLocalPort: port,
      zcProtocol: 2,
    });

    if (input.securePort && input.secret) message.zcKey = Buffer.from(input.secret, 'base64');
    runtime.world.phones.set(BigInt(user.player_id), message);

    return c.body(null, 204);
  });
  app.post('/api/profiles/:id/activities/0/rideon', (c) => {
    const user = authenticated(c);
    const profile = runtime.profiles.get(user.player_id);
    const receiver = BigInt(c.req.param('id'));

    const payload = toBinary(
      RideOnSchema,
      create(RideOnSchema, {
        playerId: BigInt(user.player_id),
        toPlayerId: receiver,
        firstName: profile.firstName,
        lastName: profile.lastName,
        countryCode: profile.countryCode,
      }),
    );

    runtime.world.enqueue(
      create(WorldAttributeSchema, {
        serverRealm: 1n,
        waType: WA_TYPE.WAT_RIDE_ON,
        worldTimeBorn: worldTime(),
        worldTimeExpire: worldTime() + 9890n,
        timestamp: BigInt(Date.now()) * 1000n,
        payload,
      }),
      [receiver],
    );

    return c.text('{}');
  });
  app.post('/relay/worlds/attributes', async (c) => {
    const user = authenticated(c);
    const id = BigInt(user.player_id);

    const update = parseProtobuf(WorldAttributeSchema, new Uint8Array(await c.req.arrayBuffer()));

    update.worldTimeExpire = worldTime() + 60_000n;
    update.waF12 = 1n;
    update.timestamp = BigInt(Date.now()) * 1000n;
    let recipients: bigint[] | undefined;

    if (update.waType === WA_TYPE.WAT_SPA) {
      const action = parseProtobuf(SocialPlayerActionSchema, update.payload);
      action.playerId = id;
      const profile = runtime.profiles.get(user.player_id);
      action.firstName = profile.firstName;
      action.lastName = profile.lastName;
      update.payload = toBinary(SocialPlayerActionSchema, action);

      if (action.message.startsWith('.')) {
        const reply = runtime.world.simulation?.command(id, action.message.slice(1)) ?? 'Simulation is unavailable.';

        sendMessage(runtime, reply, [id]);

        return c.body(null, 201);
      }

      runtime.discord?.send(action.message, `${profile.firstName} ${profile.lastName}`);
      const state = runtime.world.online.get(id);
      recipients = [...runtime.world.online].flatMap(([peerId, peer]) =>
        state &&
        course(state) === course(peer) &&
        Math.hypot(state.x - peer.x, state.z - peer.z, state.yAltitude - peer.yAltitude) <= 100_000
          ? peerId
          : [],
      );
    } else if (update.waType === WA_TYPE.WAT_B_ACT) {
      const reply = runtime.world.simulation?.gesture(id, update.payload);

      if (reply) sendMessage(runtime, reply, [id]);
    }

    runtime.world.enqueue(update, recipients);

    return c.body(null, 201);
  });
  app.post('/api/player-playbacks/player/playback', async (c) => {
    const user = authenticated(c);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const playback = parseProtobuf(PlaybackDataSchema, bytes);

    if (!playback.time) return c.body(null, 200);
    const id = randomUUID();
    writeDurable(resolve(runtime.config.storageDir, 'playbacks', `${id}.playback`), bytes);
    db.prepare('INSERT INTO playback (player_id,uuid,segment_id,time,world_time,type) VALUES (?,?,?,?,?,?)').run(
      user.player_id,
      id,
      playback.segmentId,
      playback.time,
      playback.worldTime,
      playback.type,
    );

    return c.text(id, 201);
  });
  app.get('/api/player-playbacks/player/:player/playbacks/:segment/:option', (c) => {
    const user = authenticated(c);

    const player =
      c.req.param('player') === 'me'
        ? user.player_id
        : z.coerce.number().int().positive().safe().parse(c.req.param('player'));

    const after = c.req.query('after') ?? '18446744065933551616';
    const before = c.req.query('before') ?? '0';
    const type = c.req.query('type') === 'ROUTE' ? 1 : 0;

    const query = db.prepare(
      'SELECT * FROM playback WHERE player_id=? AND segment_id=? AND type=? AND (? OR world_time>?) AND (? OR world_time<?) ORDER BY CASE WHEN ? THEN time ELSE -world_time END LIMIT 1',
    );

    query.setReadBigInts(true);

    const row = query.get(
      player,
      BigInt(c.req.param('segment')),
      type,
      after === '18446744065933551616' || runtime.config.leaderboards.allTime ? 1 : 0,
      BigInt.asIntN(64, BigInt(after)),
      before === '0' ? 1 : 0,
      BigInt.asIntN(64, BigInt(before)),
      c.req.param('option') === 'pr' ? 1 : 0,
    );

    if (!row) return c.body(null, 200);

    const parsed = z
      .object({
        uuid: z.string(),
        segment_id: z.bigint(),
        time: z.number(),
        world_time: z.bigint(),
      })
      .parse(row);

    return c.body(
      toBinary(
        PlaybackMetadataSchema,
        create(PlaybackMetadataSchema, {
          uuid: parsed.uuid,
          segmentId: parsed.segment_id,
          time: parsed.time,
          worldTime: parsed.world_time,
          type,
          url: `https://cdn.zwift.com/player-playback/playbacks/${parsed.uuid}.playback`,
        }),
      ),
    );
  });
  app.get('/player-playback/playbacks/:filename', (c) => {
    const file = c.req.param('filename');

    if (!/^[0-9a-f-]{36}\.playback$/.test(file)) throw new HTTPException(404);
    const path = resolve(runtime.config.storageDir, 'playbacks', file);

    if (!existsSync(path)) throw new HTTPException(404);

    return c.body(readFileSync(path));
  });
}
