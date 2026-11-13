import { eventFeedSchema } from '#src/dtos/relay.dto';
import { parseProtobuf } from '#src/http/protobuf';
import { authenticated, peerAddress } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import { HashSeedsSchema } from '#src/protocol/generated/hash-seeds_pb';
import {
  EconomyConfigSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  RelaySessionRefreshResponseSchema,
} from '#src/protocol/generated/login_pb';
import { PerSessionInfoSchema, TcpConfigSchema } from '#src/protocol/generated/per-session-info_pb';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import type { PlayerState } from '#src/protocol/generated/udp-node-msgs_pb';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import {
  DropInPlayerSchema,
  DropInWorldListSchema,
  DropInWorldSchema,
  TeleportTargetsSchema,
} from '#src/protocol/generated/world_pb';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { course, worldTime } from '#src/world/state';
import { create, fromJsonString, toBinary, toJsonString } from '@bufbuild/protobuf';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { resolve } from 'node:path';
import { z } from 'zod';

export function relayRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  app.post('/api/users/login', async (c) => {
    const user = authenticated(c);

    const request = parseProtobuf(LoginRequestSchema, new Uint8Array(await c.req.arrayBuffer()));

    if (runtime.world.active(user.player_id)) throw new HTTPException(409);

    if (![16, 24, 32].includes(request.key.length)) throw new HTTPException(400);

    if (c.req.header('User-Agent')?.toLowerCase().includes('android'))
      await runtime.services.workouts.syncWorkoutsAutomatically(user.player_id, true);
    runtime.world.login(BigInt(user.player_id), request.key);

    const economyPath = resolve(runtime.services.profiles.folder(user.player_id), 'economy_config.txt');

    const economy = fromJsonString(
      EconomyConfigSchema,
      runtime.services.files.read(
        runtime.services.files.exists(economyPath) ? economyPath : resolve(runtime.assets, 'data/economy_config.txt'),
        'utf8',
      ),
    );

    if (!runtime.services.files.exists(economyPath)) {
      const profile = runtime.services.profiles.get(user.player_id);
      const currentLevel = Math.floor(profile.achievementLevel / 100);

      const levels = economy.cyclingLevels.filter((level) => level.level >= currentLevel);

      const first = levels[0];
      const next = levels[1];

      if (first && next && profile.totalXp > next.xp) {
        const offset = profile.totalXp - first.xp;

        const transitionEnd = levels.findLast((level) => level.xp <= profile.totalXp)?.level ?? currentLevel;

        for (const level of economy.cyclingLevels) if (level.level >= currentLevel) level.xp += offset;

        if (transitionEnd > currentLevel) {
          economy.transitionStart = currentLevel;
          economy.transitionEnd = transitionEnd;
        }
      } else if (first && profile.totalXp < first.xp) {
        const offset = first.xp - profile.totalXp;

        for (const level of economy.cyclingLevels)
          if (level.level <= currentLevel) level.xp = Math.max(0, level.xp - offset);
      }

      runtime.services.files.write(economyPath, toJsonString(EconomyConfigSchema, economy));
    }

    const peer = peerAddress(c);

    const ip = peer === '127.0.0.1' || peer === '::1' ? peer : runtime.config.server.advertisedIp;

    const response = create(LoginResponseSchema, {
      sessionState: 'abc',
      info: {
        relayUrl: 'https://us-or-rly101.zwift.com/relay',
        time: BigInt(Math.floor(Date.now() / 1000)),
        apis: {
          todaysplanUrl: 'https://whats.todaysplan.com.au',
          trainingpeaksUrl: 'https://api.trainingpeaks.com',
        },
        nodes: { nodes: [{ ip, port: runtime.config.network.tcp.port }] },
      },
      relaySessionId: user.player_id,
      expiration: 70,
      economyConfig: economy,
    });

    return c.body(toBinary(LoginResponseSchema, response));
  });
  app.post('/api/users/logout', (c) => {
    runtime.world.logout(BigInt(authenticated(c).player_id));

    return c.body(null, 204);
  });
  app.post('/relay/session/:action', (c) => {
    const user = authenticated(c);

    if (!['refresh', 'renew'].includes(c.req.param('action'))) throw new HTTPException(404);

    return c.body(
      toBinary(
        RelaySessionRefreshResponseSchema,
        create(RelaySessionRefreshResponseSchema, {
          relaySessionId: user.player_id,
          expiration: 70,
        }),
      ),
    );
  });
  app.get('/api/tcp-config', (c) =>
    c.body(
      toBinary(
        TcpConfigSchema,
        create(TcpConfigSchema, {
          nodes: [{ ip: runtime.config.server.advertisedIp, port: runtime.config.network.tcp.port }],
        }),
      ),
    ),
  );
  app.get('/relay/tcp-config', (c) =>
    c.body(
      toBinary(
        TcpConfigSchema,
        create(TcpConfigSchema, {
          nodes: [{ ip: runtime.config.server.advertisedIp, port: runtime.config.network.tcp.port }],
        }),
      ),
    ),
  );
  app.on('GET', ['/relay/worlds', '/relay/dropin'], (c) => {
    const user = authenticated(c);

    const bookmarks = runtime.world.simulation?.loadBookmarks(BigInt(user.player_id)) ?? new Map();

    if (c.req.header('Accept')?.includes('application/json')) return c.json([worldJSON(1)]);

    return c.body(toBinary(DropInWorldListSchema, worlds(bookmarks)));
  });
  app.get('/relay/worlds/hash-seeds', (c) =>
    c.body(
      toBinary(
        HashSeedsSchema,
        create(HashSeedsSchema, {
          seeds: Array.from({ length: 4 }, (_, index) => ({
            seed1: new CryptoRepository().randomInt(0x80_00_00_00),
            seed2: new CryptoRepository().randomInt(0x80_00_00_00),
            expiryDate: worldTime() + BigInt(10_800 + index * 1200) * 1000n,
          })),
        }),
      ),
    ),
  );
  app.get('/relay/worlds/:realm/aggregate/mobile', async (c) => {
    const user = authenticated(c);

    const count = (name: string) =>
      z.coerce
        .number()
        .int()
        .min(0)
        .max(1000)
        .parse(c.req.query(name) ?? 0);

    const headers = new Headers(c.req.raw.headers);
    headers.set('Accept', 'application/json');

    const read = async <T extends z.ZodType>(path: string, schema: T) => {
      const response = await app.request(path, { headers });

      if (!response.ok) throw new HTTPException(502);

      return schema.parse(await response.json());
    };

    const invites = (status: string, limit: number) =>
      limit > 0
        ? read(
            '/api/private_event/feed?start_date=-1800000',
            z.array(
              z.looseObject({
                inviteStatus: z.string(),
                eventInvites: z.array(
                  z.looseObject({
                    invitedProfile: z.looseObject({ id: z.number() }),
                  }),
                ),
              }),
            ),
          ).then((events) =>
            events
              .filter(
                (event) =>
                  event.inviteStatus === status &&
                  event.eventInvites.some((invite) => invite.invitedProfile.id === user.player_id),
              )
              .slice(0, limit),
          )
        : Promise.resolve([]);

    const goalCount = count('goalCount');
    const activityCount = count('activityCount');
    const eventCount = count('eventCount');
    const sport = c.req.query('eventSport');
    const eventQuery = new URLSearchParams({ limit: String(eventCount) });

    if (sport) eventQuery.set('sport', sport);

    const [goals, activities, events, pending, accepted] = await Promise.all([
      goalCount
        ? read(`/api/profiles/${user.player_id}/goals`, z.array(z.json())).then((all) => all.slice(0, goalCount))
        : Promise.resolve([]),
      activityCount
        ? read(
            `/api/activity-feed/feed/?${new URLSearchParams({ feedType: 'preview', limit: String(activityCount) })}`,
            z.array(z.json()),
          )
        : Promise.resolve([]),
      eventCount
        ? read(`/api/event-feed?${eventQuery}`, eventFeedSchema).then((feed) => feed.data.map((item) => item.event))
        : Promise.resolve([]),
      invites('PENDING', count('pendingEventInviteCount')),
      invites('ACCEPTED', count('acceptedEventInviteCount')),
    ]);

    return c.json({
      events,
      goals,
      activities,
      pendingPrivateEventFeed: pending,
      acceptedPrivateEventFeed: accepted,
      hasFolloweesToRideOn: false,
      worldName: 'MAKURIISLANDS',
      playerCount: runtime.world.online.size,
      followingPlayerCount: 0,
      followingPlayers: [],
    });
  });
  app.on('GET', ['/relay/worlds/:realm', '/relay/worlds/:realm/'], (c) => {
    const realm = z.coerce.number().int().positive().parse(c.req.param('realm'));

    if (c.req.header('Accept')?.includes('application/json')) return c.json(worldJSON(realm));
    const world = worlds(new Map()).worlds.at(-1);

    if (!world) throw new HTTPException(404);
    world.id = BigInt(realm);

    return c.body(toBinary(DropInWorldSchema, world));
  });
  app.post('/relay/worlds/:realm/join', (c) => c.text(JSON.stringify({ worldTime: Number(worldTime()) })));
  app.post('/relay/worlds/:realm/leave', (c) => c.text(JSON.stringify({ worldtime: Number(worldTime()) })));
  app.get('/relay/worlds/:realm/players/:id', (c) => {
    const user = authenticated(c);
    const id = BigInt(c.req.param('id'));

    const state =
      runtime.world.online.get(id) ??
      runtime.world.synthetic.get(id) ??
      runtime.world.personal.get(BigInt(user.player_id))?.get(id) ??
      runtime.world.simulation?.bookmarks.get(BigInt(user.player_id))?.get(id)?.state;

    if (!state) throw new HTTPException(404);

    return c.body(toBinary(PlayerStateSchema, state));
  });
  app.get('/relay/teleport-targets', (c) => {
    const user = authenticated(c);
    const revision = Number(c.req.query('mapRevisionId'));
    const targets = create(TeleportTargetsSchema);

    for (const [id, state] of [...runtime.world.online, ...runtime.world.synthetic]) {
      if (id === BigInt(user.player_id) || course(state) !== revision) continue;
      const pacer = runtime.world.simulation?.replays.get(id)?.pacer;

      if (!pacer && !runtime.world.online.has(id)) continue;
      const target = player(state);
      target.ridePower = state.power;
      target.speed = state.speed;

      if (pacer) targets.pacerGroups.push(target);
      else targets.friends.push(target);
    }

    const bookmarks = runtime.world.simulation?.bookmarks.get(BigInt(user.player_id));

    if (bookmarks)
      for (const bookmark of bookmarks.values())
        if (course(bookmark.state) === revision) targets.friends.push(player(bookmark.state, bookmark.name));

    return c.body(toBinary(TeleportTargetsSchema, targets));
  });
  app.get('/api/per-session-info', (c) =>
    c.body(
      toBinary(
        PerSessionInfoSchema,
        create(PerSessionInfoSchema, {
          relayUrl: 'https://us-or-rly101.zwift.com/relay',
        }),
      ),
    ),
  );
  app.get('/api/events/subgroups/entrants/:id', (c) =>
    c.req.header('Accept') === 'application/x-protobuf-lite' ? c.body(null, 200) : c.text('[]'),
  );

  function player(state: PlayerState, bookmark?: string) {
    const profile = bookmark
      ? create(PlayerProfileSchema, {
          id: state.id,
          firstName: '',
          lastName: bookmark,
        })
      : runtime.services.profiles.get(Number(state.id));

    return create(DropInPlayerSchema, {
      id: state.id,
      firstName: profile.firstName,
      lastName: profile.lastName,
      distance: BigInt(state.distance),
      time: BigInt(state.time),
      countryCode: BigInt(profile.countryCode),
      sport: state.sport,
      power: BigInt(state.power),
      x: state.x,
      yAltitude: state.yAltitude,
      z: state.z,
      route: state.route,
      ridePower: state.power,
      speed: state.speed,
    });
  }

  function worlds(bookmarks: Map<bigint, { state: PlayerState; name: string }>) {
    const worlds = create(DropInWorldListSchema);

    for (const id of [2, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]) {
      const world = create(DropInWorldSchema, {
        id: 1n,
        name: 'Public Watopia',
        courseId: BigInt(id),
        worldTime: worldTime(),
        realTime: BigInt(Math.floor(Date.now() / 1000)),
        zwifters: 0n,
      });

      for (const state of runtime.world.online.values())
        if (course(state) === id) {
          world.followees.push(player(state));
          world.zwifters++;
        }

      for (const [key, state] of runtime.world.synthetic)
        if (course(state) === id) {
          if (runtime.world.simulation?.replays.get(key)?.pacer) world.pacerBots.push(player(state));
          else world.others.push(player(state));
          world.zwifters++;
        }

      for (const bookmark of bookmarks.values())
        if (course(bookmark.state) === id) {
          world.proPlayers.push(player(bookmark.state, bookmark.name));
          world.zwifters++;
        }

      worlds.worlds.push(world);
    }

    return worlds;
  }

  function worldJSON(realm: number) {
    return {
      currentDateTime: Math.floor(Date.now() / 1000),
      currentWorldTime: Number(worldTime()),
      friendsInWorld: [...runtime.world.online].map(([id, state]) => {
        const profile = runtime.services.profiles.get(Number(id));

        return {
          playerId: Number(id),
          firstName: profile.firstName,
          lastName: profile.lastName,
          male: profile.isMale,
          countryISOCode: profile.countryCode,
          totalDistanceInMeters: state.distance,
          rideDurationInSeconds: state.time,
          playerType: profile.playerType,
          followerStatusOfLoggedInPlayer: 'NO_RELATIONSHIP',
          rideOnGiven: false,
          currentSport: state.sport === 1 ? 'RUNNING' : 'CYCLING',
          enrolledZwiftAcademy: false,
          mapId: 1,
          ftp: 100,
          runTime10kmInSeconds: 3600,
        };
      }),
      mapId: 1,
      name: 'Public Watopia',
      playerCount: runtime.world.online.size,
      worldId: realm,
    };
  }
}
