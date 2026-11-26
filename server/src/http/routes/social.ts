import { t } from '#src/i18n/index';
import { AccountsService } from '#src/services/auth.service';
import { FilesService } from '#src/services/files.service';
import { ProfilesService } from '#src/services/profile.service';
import { DocumentsService } from '#src/services/documents.service';
import { effectRoutes } from '#src/http/effect';
import { SocialService } from '#src/services/social.service';
import {
  profileSearchSchema,
  privacyUpdateSchema,
  companionConnectionSchema,
  playbackRecordSchema,
} from '#src/dtos/social.dto';

import { parseProtobuf } from '#src/http/protobuf';
import { authenticated } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import { PlaybackDataSchema, PlaybackMetadataSchema } from '#src/protocol/generated/playback_pb';
import { PlayerProfileSchema, PlayerProfilesSchema } from '#src/protocol/generated/profile_pb';
import { SocialPlayerActionSchema } from '#src/protocol/generated/tcp-node-msgs_pb';
import {
  RideOnSchema,
  ServerToClientSchema,
  WA_TYPE,
  WorldAttributeSchema,
} from '#src/protocol/generated/udp-node-msgs_pb';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { course, worldTime } from '#src/world/state';
import { create, toBinary } from '@bufbuild/protobuf';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { resolve } from 'node:path';
import { Effect, Schema } from 'effect';
import { NumberFromInput } from '#src/schema';

export function socialRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const appRoutes = effectRoutes(app, runtime);

  const summary = (id: number) => {
    const profile = runtime.effects.runSync(ProfilesService.use((service) => service.get(id)));

    const image = runtime.effects.runSync(
      Effect.flatMap(
        ProfilesService.use((service) => service.folder(id)),
        (folder) => FilesService.use((files) => files.exists(resolve(folder, 'avatarLarge.jpg'))),
      ),
    )
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

  appRoutes.get('/api/profiles', (c) =>
    Effect.gen(function* () {
      const profilesService = yield* ProfilesService;

      const ids = Schema.decodeUnknownSync(
        Schema.Array(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0))).check(Schema.isMaxLength(1000)),
      )(c.req.queries('id') ?? []);

      return c.body(
        toBinary(
          PlayerProfilesSchema,
          create(PlayerProfilesSchema, {
            profiles: yield* Effect.forEach(ids, (id) =>
              profilesService.synthetic.has(BigInt(id)) || runtime.effects.runSync(AccountsService).get(id)
                ? profilesService
                    .get(id)
                    .pipe(Effect.flatMap((profile) => profilesService.forViewer(profile, c.get('user')?.player_id)))
                : Effect.succeed(
                    create(PlayerProfileSchema, {
                      id: BigInt(id),
                      lastName: id > 9_000_000 && id < 10_000_000 ? t('bookmark') : '',
                    }),
                  ),
            ),
          }),
        ),
      );
    }),
  );
  app.on(
    'GET',
    ['/api/profiles/:id/followers', '/api/profiles/:id/followees', '/api/profiles/:id/followees-in-common/:other'],
    (c) => {
      authenticated(c);

      if (c.req.header('Accept') === 'application/x-protobuf-lite') {
        return c.body(null, 200);
      }

      return c.json(
        runtime.effects
          .runSync(AccountsService)
          .list()
          .map((user) => ({
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
  appRoutes.on('POST', ['/api/search/profiles', '/api/search/profiles/restricted'], (c) =>
    Effect.gen(function* () {
      const socialService = yield* SocialService;

      authenticated(c);
      const input = Schema.decodeUnknownSync(profileSearchSchema)(yield* Effect.promise(() => c.req.json()));

      const start = Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)))(
        c.req.query('start') ?? 0,
      );

      const limit = Schema.decodeUnknownSync(
        NumberFromInput.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1000)),
      )(c.req.query('limit') ?? 100);

      const rows = yield* socialService.listUser(`%${input.query}%`, `%${input.query}%`, limit, start);

      return c.json(rows.map((row) => summary(Schema.decodeUnknownSync(Schema.Finite)(row.player_id))));
    }),
  );
  appRoutes.post('/api/profiles/:id/privacy', (c) =>
    Effect.gen(function* () {
      const profilesService = yield* ProfilesService;

      const documentsService = yield* DocumentsService;

      const user = authenticated(c);

      if (String(user.player_id) !== c.req.param('id')) {
        throw new HTTPException(401);
      }

      const input = Schema.decodeUnknownSync(privacyUpdateSchema)(yield* Effect.promise(() => c.req.json()));

      const profile = yield* profilesService.get(user.player_id);
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
      yield* profilesService.save(user.player_id, profile);
      yield* documentsService.put(user.player_id, 'privacy.json', JSON.stringify(input));

      return c.body(null, 200);
    }),
  );
  appRoutes.get('/api/profiles/:id/statistics', (c) =>
    Effect.gen(function* () {
      const socialService = yield* SocialService;

      const row = yield* socialService.findActivity(c.req.param('id'), c.req.query('startDateTime') ?? '1970-01-01');

      return c.json(Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.NullOr(Schema.Finite)))(row));
    }),
  );
  appRoutes.post('/api/profiles/:id/photo', (c) =>
    Effect.gen(function* () {
      const filesService = yield* FilesService;

      const profilesService = yield* ProfilesService;

      const user = authenticated(c);

      if (String(user.player_id) !== c.req.param('id')) {
        throw new HTTPException(401);
      }
      let image: Uint8Array;

      if (c.req.header('Content-Type')?.toLowerCase().startsWith('multipart/form-data')) {
        const form = yield* Effect.tryPromise({ try: () => c.req.formData(), catch: () => new HTTPException(400) });

        const file = form.values().find((value) => value instanceof File);

        if (!(file instanceof File)) {
          throw new HTTPException(400);
        }
        image = new Uint8Array(yield* Effect.promise(() => file.arrayBuffer()));
      } else {
        image = new Uint8Array(yield* Effect.promise(() => c.req.arrayBuffer()));
      }

      if (
        image.length < 4 ||
        image[0] !== 0xff ||
        image[1] !== 0xd8 ||
        image.at(-2) !== 0xff ||
        image.at(-1) !== 0xd9
      ) {
        throw new HTTPException(400);
      }
      yield* filesService.write(resolve(yield* profilesService.folder(user.player_id), 'avatarLarge.jpg'), image, true);

      return c.body(null, 200);
    }),
  );
  app.put('/relay/profiles/me/phone', async (c) => {
    const user = authenticated(c);

    const input = Schema.decodeUnknownSync(companionConnectionSchema)(await c.req.json());

    const port = input.securePort ?? input.port;

    if (!port || (input.securePort && !input.secret)) {
      throw new HTTPException(400);
    }

    const message = create(ServerToClientSchema, {
      playerId: BigInt(user.player_id),
      worldTime: 0n,
      zcLocalIp: input.phoneAddress,
      zcLocalPort: port,
      zcProtocol: 2,
    });

    if (input.securePort && input.secret) {
      message.zcKey = Buffer.from(input.secret, 'base64');
    }
    runtime.world.phones.set(BigInt(user.player_id), message);
    runtime.world.lifecycle.companion(BigInt(user.player_id));

    return c.body(null, 204);
  });
  appRoutes.post('/api/profiles/:id/activities/0/rideon', (c) =>
    Effect.gen(function* () {
      const profilesService = yield* ProfilesService;

      const user = authenticated(c);
      const profile = yield* profilesService.get(user.player_id);
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
    }),
  );
  appRoutes.post('/relay/worlds/attributes', (c) =>
    Effect.gen(function* () {
      const profilesService = yield* ProfilesService;

      const socialService = yield* SocialService;

      const user = authenticated(c);
      const id = BigInt(user.player_id);

      // Leave room for the ServerToClient envelope and encrypted TCP framing.
      const maxAttributeBytes = 60 * 1024;
      const bytes = new Uint8Array(yield* Effect.promise(() => c.req.arrayBuffer()));

      if (bytes.length > maxAttributeBytes) {
        throw new HTTPException(413);
      }
      const update = parseProtobuf(WorldAttributeSchema, bytes);

      update.worldTimeExpire = worldTime() + 60_000n;
      update.waF12 = 1n;
      update.timestamp = BigInt(Date.now()) * 1000n;
      let recipients: Array<bigint> | undefined;

      if (update.waType === WA_TYPE.WAT_SPA) {
        const action = parseProtobuf(SocialPlayerActionSchema, update.payload);
        action.playerId = id;
        const profile = yield* profilesService.get(user.player_id);
        action.firstName = profile.firstName;
        action.lastName = profile.lastName;
        update.payload = toBinary(SocialPlayerActionSchema, action);

        if (action.message.startsWith('.')) {
          const reply = runtime.world.simulation?.command(id, action.message.slice(1)) ?? t('simulation_unavailable');

          yield* socialService.sendMessage(reply, [id]);

          return c.body(null, 201);
        }

        for (const bridge of runtime.bridges ?? []) {
          bridge.send(action.message, `${profile.firstName} ${profile.lastName}`);
        }
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

        if (reply) {
          yield* socialService.sendMessage(reply, [id]);
        }
      }

      if (toBinary(WorldAttributeSchema, update).length > maxAttributeBytes) {
        throw new HTTPException(413);
      }
      runtime.world.enqueue(update, recipients);

      return c.body(null, 201);
    }),
  );
  appRoutes.post('/api/player-playbacks/player/playback', (c) =>
    Effect.gen(function* () {
      const filesService = yield* FilesService;

      const socialService = yield* SocialService;

      const user = authenticated(c);
      const bytes = new Uint8Array(yield* Effect.promise(() => c.req.arrayBuffer()));
      const playback = parseProtobuf(PlaybackDataSchema, bytes);

      if (!playback.time) {
        return c.body(null, 200);
      }
      const id = new CryptoRepository().randomUUID();
      yield* filesService.write(resolve(runtime.config.storageDir, 'playbacks', `${id}.playback`), bytes);
      yield* socialService.insertPlayback(
        user.player_id,
        id,
        playback.segmentId,
        playback.time,
        playback.worldTime,
        playback.type,
      );

      return c.text(id, 201);
    }),
  );
  appRoutes.get('/api/player-playbacks/player/:player/playbacks/:segment/:option', (c) =>
    Effect.gen(function* () {
      const socialService = yield* SocialService;

      const user = authenticated(c);

      const player =
        c.req.param('player') === 'me'
          ? user.player_id
          : Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(
              c.req.param('player'),
            );

      const after = c.req.query('after') ?? '18446744065933551616';
      const before = c.req.query('before') ?? '0';
      const type = c.req.query('type') === 'ROUTE' ? 1 : 0;

      const row = yield* socialService.playbackForSegment(
        player,
        BigInt(c.req.param('segment')),
        type,
        after === '18446744065933551616' || runtime.config.leaderboards.allTime ? 1 : 0,
        BigInt.asIntN(64, BigInt(after)),
        before === '0' ? 1 : 0,
        BigInt.asIntN(64, BigInt(before)),
        c.req.param('option') === 'pr' ? 1 : 0,
      );

      if (!row) {
        return c.body(null, 200);
      }

      const parsed = Schema.decodeUnknownSync(playbackRecordSchema)(row);

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
    }),
  );
  appRoutes.get('/player-playback/playbacks/:filename', (c) =>
    Effect.gen(function* () {
      const filesService = yield* FilesService;

      const file = c.req.param('filename');

      if (!/^[0-9a-f-]{36}\.playback$/.test(file)) {
        throw new HTTPException(404);
      }
      const path = resolve(runtime.config.storageDir, 'playbacks', file);

      if (!(yield* filesService.exists(path))) {
        throw new HTTPException(404);
      }

      return c.body(yield* filesService.read(path));
    }),
  );
}
