import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { create, toBinary } from '@bufbuild/protobuf';
import { z } from 'zod';
import { eventsAt, eventJSON } from '#src/domain/events/catalog';
import {
  EventsSchema,
  EventSchema,
  PlayerJoinedEventSchema,
  PlayerLeftEventSchema,
  PrivateEventProtoSchema,
  PrivateEventFeedListProtoSchema,
  PrivateEventFeedProtoSchema,
  LateJoinInformationSchema,
} from '#src/protocol/generated/events_pb';
import { WorldAttributeSchema, WA_TYPE } from '#src/protocol/generated/udp-node-msgs_pb';
import { worldTime, road, forward } from '#src/world/state';
import type { Runtime, RuntimeEnv } from '#src/http/runtime';
import { authenticated } from '#src/http/routes/accounts';

function social(event: Meetup, id: number) {
  return {
    ...event,
    inviteStatus: event.eventInvites.find((invite) => invite.invitedProfile.id === id)?.status ?? 'PENDING',
    eventInvites: event.eventInvites.map((invite) => ({
      ...invite,
      invitedProfile: {
        ...invite.invitedProfile,
        socialFacts: {
          followerStatusOfLoggedInPlayer: invite.invitedProfile.id === id ? 'SELF' : 'IS_FOLLOWING',
          isFavoriteOfLoggedInPlayer: invite.invitedProfile.id !== id,
        },
      },
    })),
  };
}

function visible(event: Meetup, id: number) {
  return event.organizerProfileId === id || event.invitedProfileIds.includes(id);
}

const limit = (value: string | undefined) =>
  z.coerce
    .number()
    .int()
    .min(0)
    .max(1000)
    .parse(value ?? 100);

const inputSchema = z.object({
  culling: z.boolean().default(false),
  description: z.string().default(''),
  distanceInMeters: z.number().nonnegative(),
  durationInSeconds: z.number().int().nonnegative(),
  eventStart: z.iso.datetime(),
  invitedProfileIds: z.array(z.number().int().positive().safe()).max(100),
  laps: z.number().int().nonnegative(),
  routeId: z.number().int().nonnegative().safe(),
  rubberbanding: z.boolean(),
  showResults: z.boolean(),
  sport: z.enum(['CYCLING', 'RUNNING']),
  workoutHash: z.number().int().nonnegative().safe(),
});

const profileSchema = z
  .object({
    id: z.number().int().positive(),
    firstName: z.string(),
    lastName: z.string(),
    male: z.boolean(),
    imageSrc: z.string().nullable(),
    playerType: z.string(),
    enrolledZwiftAcademy: z.boolean(),
  })
  .passthrough();

const inviteSchema = z.object({
  invitedProfile: profileSchema,
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED']),
});

const storedSchema = inputSchema.extend({
  id: z.number(),
  eventSubgroupId: z.number(),
  name: z.string(),
  organizerProfileId: z.number(),
  organizerId: z.number(),
  organizerFirstName: z.string(),
  organizerLastName: z.string(),
  organizerImageUrl: z.string().nullable(),
  updateDate: z.string(),
  invitedTotalCount: z.number(),
  acceptedTotalCount: z.number(),
  acceptedFolloweeCount: z.number(),
  startLocation: z.number(),
  allowsLateJoin: z.boolean(),
  eventInvites: z.array(inviteSchema),
});

type Meetup = z.infer<typeof storedSchema>;

export function eventRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const db = runtime.accounts.db;

  function profile(id: number) {
    const rider = runtime.profiles.get(id);

    return {
      id,
      firstName: rider.firstName,
      lastName: rider.lastName,
      male: rider.isMale,
      imageSrc: rider.largeAvatarUrl || null,
      playerType: 'NORMAL',
      enrolledZwiftAcademy: false,
    };
  }

  function read(id: string) {
    const row = db.prepare('SELECT json FROM private_event WHERE id=?').get(id);

    if (!row) throw new HTTPException(404);

    return storedSchema.parse(JSON.parse(z.string().parse(row.json)));
  }

  function all() {
    return db
      .prepare('SELECT json FROM private_event ORDER BY id DESC LIMIT 100')
      .all()
      .map((row) => storedSchema.parse(JSON.parse(z.string().parse(row.json))));
  }

  function save(event: Meetup) {
    db.prepare('UPDATE private_event SET json=? WHERE id=?').run(JSON.stringify(event), event.id);
  }

  function broadcast(event: Meetup) {
    const payload = toBinary(
      EventSchema,
      create(EventSchema, {
        id: BigInt(event.id),
        serverRealm: 1n,
        name: event.name,
        description: event.description,
        eventStart: BigInt(Date.parse(event.eventStart)),
        distanceInMeters: event.distanceInMeters,
        laps: event.laps,
        durationInSeconds: event.durationInSeconds,
        routeId: BigInt(event.routeId),
        visible: true,
        jerseyHash: 0n,
        sport: event.sport === 'RUNNING' ? 1 : 0,
        eventType: event.culling ? 2 : 1,
        eF27: 2n,
        lateJoinInMinutes: 30,
      }),
    );

    const recipients = [event.organizerProfileId, ...event.invitedProfileIds];

    for (const id of recipients)
      runtime.world.enqueue(
        create(WorldAttributeSchema, {
          serverRealm: 1n,
          waType: WA_TYPE.WAT_INV_W,
          payload,
          worldTimeBorn: worldTime(),
          worldTimeExpire: worldTime() + 60_000n,
          waF12: 1n,
          timestamp: BigInt(Date.now()) * 1000n,
          relId: BigInt(id),
        }),
        [BigInt(id)],
      );
  }

  function notify(event: Meetup, id: number) {
    const notificationId = Number(
      db.prepare('INSERT INTO notification (event_id,player_id,json) VALUES (?,?,?)').run(event.id, id, '')
        .lastInsertRowid,
    );

    const organizer = profile(event.organizerProfileId);

    const notification = {
      activity: null,
      argLong0: 0,
      argLong1: 0,
      argString0: JSON.stringify({
        eventId: event.id,
        eventStartDate: Math.floor(Date.parse(event.eventStart) / 1000),
        otherInviteeCount: event.invitedProfileIds.length,
      }),
      createdOn: new Date().toISOString().replace('Z', '+0000'),
      fromProfile: {
        ...organizer,
        imageSrcLarge: organizer.imageSrc,
        publicId: '283b140f-91d2-4882-bd8e-e4194ddf7128',
        socialFacts: {
          favoriteOfLoggedInPlayer: true,
          followeeStatusOfLoggedInPlayer: 'IS_FOLLOWING',
          followerStatusOfLoggedInPlayer: 'IS_FOLLOWING',
        },
      },
      id: notificationId,
      lastModified: null,
      read: false,
      readDate: null,
      type: 'PRIVATE_EVENT_INVITE',
    };

    db.prepare('UPDATE notification SET json=? WHERE id=?').run(JSON.stringify(notification), notificationId);
  }

  app.get('/api/event-feed', (c) =>
    c.json({
      data: eventsAt(runtime.assets, limit(c.req.query('limit')), c.req.query('sport')).map((event) => ({
        event: eventJSON(event),
      })),
      cursor: null,
    }),
  );
  app.post('/api/events/search', (c) => {
    const events = eventsAt(runtime.assets, limit(c.req.query('limit')));

    return c.req.header('Accept')?.includes('application/json')
      ? c.json(events.map((event) => eventJSON(event)))
      : c.body(toBinary(EventsSchema, create(EventsSchema, { events })));
  });
  app.get('/api/events/:id', (c) => {
    const event = eventsAt(runtime.assets).find((item) => item.id === BigInt(c.req.param('id')));

    return event ? c.json(eventJSON(event)) : c.body(null, 200);
  });
  app.on(['POST', 'DELETE'], ['/api/events/subgroups/signup/:id', '/api/events/signup/:id'], (c) => {
    const user = authenticated(c);
    const joining = c.req.method === 'POST';
    const id = BigInt(c.req.param('id'));

    const payload = joining
      ? toBinary(
          PlayerJoinedEventSchema,
          create(PlayerJoinedEventSchema, {
            relId: id,
            playerId: BigInt(user.player_id),
          }),
        )
      : toBinary(
          PlayerLeftEventSchema,
          create(PlayerLeftEventSchema, {
            relId: id,
            playerId: BigInt(user.player_id),
          }),
        );

    runtime.world.enqueue(
      create(WorldAttributeSchema, {
        serverRealm: 1n,
        waType: joining ? WA_TYPE.WAT_JOIN_E : WA_TYPE.WAT_LEFT_E,
        payload,
        worldTimeBorn: worldTime(),
        worldTimeExpire: worldTime() + 60_000n,
        waF12: 1n,
        timestamp: BigInt(Date.now()) * 1000n,
        relId: BigInt(user.player_id),
      }),
      [...new Set([...runtime.world.online.keys(), BigInt(user.player_id)])],
    );

    return c.json({ signedUp: joining });
  });
  app.get('/api/private_event/feed', (c) => {
    const user = authenticated(c);
    let start = Number(c.req.query('start_date') ?? 0);

    if (start === -1_800_000) start += Date.now();

    const events = all().filter(
      (event) =>
        visible(event, user.player_id) &&
        (Date.parse(event.eventStart) > start ||
          (c.req.query('organizer_only_past_events') === 'true' && event.organizerProfileId === user.player_id)),
    );

    if (c.req.header('Accept')?.includes('application/json'))
      return c.json(events.map((event) => social(event, user.player_id)));

    return c.body(
      toBinary(
        PrivateEventFeedListProtoSchema,
        create(PrivateEventFeedListProtoSchema, {
          pef: events.map((event) =>
            create(PrivateEventFeedProtoSchema, {
              eventId: BigInt(event.id),
              sport: event.sport === 'RUNNING' ? 1 : 0,
              eventSubgroupStart: BigInt(Date.parse(event.eventStart)),
              routeId: BigInt(event.routeId),
              durationInSeconds: event.durationInSeconds,
              distanceInMeters: event.distanceInMeters,
              answeredCount: 1n,
              invitedTotalCount: event.invitedTotalCount,
              acceptedFolloweeCount: event.acceptedFolloweeCount,
              acceptedTotalCount: event.acceptedTotalCount,
              organizerImageUrl: event.organizerImageUrl ?? '',
              organizerProfileId: BigInt(event.organizerProfileId),
              organizerFirstName: event.organizerFirstName,
              organizerLastName: event.organizerLastName,
              updateDate: BigInt(Date.parse(event.updateDate)),
              subgroupId: BigInt(event.eventSubgroupId),
              laps: event.laps,
              rubberbanding: event.rubberbanding,
            }),
          ),
        }),
      ),
    );
  });
  app.post('/api/private_event', async (c) => {
    const user = authenticated(c);
    const input = inputSchema.parse(await c.req.json());
    input.invitedProfileIds = [...new Set(input.invitedProfileIds)].filter((id) => id !== user.player_id);

    for (const id of input.invitedProfileIds) if (!runtime.accounts.get(id)) throw new HTTPException(400);
    db.exec('BEGIN IMMEDIATE');
    let event: Meetup;

    try {
      const id = Number(db.prepare('INSERT INTO private_event (json) VALUES (?)').run('{}').lastInsertRowid);

      const organizer = profile(user.player_id);
      event = {
        ...input,
        id,
        eventSubgroupId: id,
        name: `Route #${input.routeId}`,
        organizerProfileId: user.player_id,
        organizerId: user.player_id,
        organizerFirstName: organizer.firstName,
        organizerLastName: organizer.lastName,
        organizerImageUrl: organizer.imageSrc,
        updateDate: new Date().toISOString(),
        acceptedTotalCount: input.invitedProfileIds.length,
        acceptedFolloweeCount: input.invitedProfileIds.length + 1,
        invitedTotalCount: input.invitedProfileIds.length + 1,
        startLocation: 1,
        allowsLateJoin: true,
        eventInvites: [
          { invitedProfile: organizer, status: 'ACCEPTED' },
          ...input.invitedProfileIds.map((id) => ({
            invitedProfile: profile(id),
            status: z.literal('PENDING').parse('PENDING'),
          })),
        ],
      };
      save(event);

      for (const id of input.invitedProfileIds) notify(event, id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    broadcast(event);

    return c.json({ id: event.id }, 201);
  });
  app.on(['GET', 'PUT', 'DELETE'], '/api/private_event/:id', async (c) => {
    const user = authenticated(c);
    const event = read(c.req.param('id'));

    if (!visible(event, user.player_id)) throw new HTTPException(403);

    if (c.req.method === 'GET') {
      if (c.req.header('Accept')?.includes('application/json')) return c.json(social(event, user.player_id));

      return c.body(
        toBinary(
          PrivateEventProtoSchema,
          create(PrivateEventProtoSchema, {
            id: BigInt(event.id),
            sport: event.sport === 'RUNNING' ? 1 : 0,
            eventStart: BigInt(Date.parse(event.eventStart)),
            routeId: BigInt(event.routeId),
            startLocation: BigInt(event.startLocation),
            durationInSeconds: event.durationInSeconds,
            distanceInMeters: event.distanceInMeters,
            description: event.description,
            workoutHash: BigInt(event.workoutHash),
            organizerId: BigInt(event.organizerProfileId),
            showResults: event.showResults,
            laps: event.laps,
            rubberbanding: event.rubberbanding,
            eventInvites: event.eventInvites.map((invite) => ({
              profile: {
                playerId: BigInt(invite.invitedProfile.id),
                firstName: invite.invitedProfile.firstName,
                lastName: invite.invitedProfile.lastName,
                imageSrc: invite.invitedProfile.imageSrc ?? '',
                enrolledZwiftAcademy: invite.invitedProfile.enrolledZwiftAcademy,
                male: invite.invitedProfile.male,
                playerType: 1,
                eventCategory: invite.invitedProfile.male ? 1 : 0,
              },
              status: invite.status === 'ACCEPTED' ? 1 : invite.status === 'REJECTED' ? 2 : 0,
            })),
          }),
        ),
      );
    }

    if (event.organizerProfileId !== user.player_id && !user.is_admin) throw new HTTPException(403);

    if (c.req.method === 'DELETE') {
      db.exec('BEGIN IMMEDIATE');

      try {
        db.prepare('DELETE FROM private_event WHERE id=?').run(event.id);
        db.prepare('DELETE FROM notification WHERE event_id=?').run(event.id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }

      return c.body(null, 200);
    }

    const update = inputSchema.parse(await c.req.json());

    for (const id of update.invitedProfileIds) if (!runtime.accounts.get(id)) throw new HTTPException(400);
    const next = { ...event, ...update, updateDate: new Date().toISOString() };
    next.eventInvites = [
      { invitedProfile: profile(event.organizerProfileId), status: 'ACCEPTED' },
      ...update.invitedProfileIds
        .filter((id) => id !== event.organizerProfileId)
        .map(
          (id) =>
            event.eventInvites.find((invite) => invite.invitedProfile.id === id) ?? {
              invitedProfile: profile(id),
              status: z.literal('PENDING').parse('PENDING'),
            },
        ),
    ];
    save(next);

    for (const id of update.invitedProfileIds) if (!event.invitedProfileIds.includes(id)) notify(next, id);
    broadcast(next);

    return c.json({ id: event.id });
  });
  app.put('/api/private_event/:id/:decision{accept|reject}', (c) => {
    const user = authenticated(c);
    const event = read(c.req.param('id'));

    const invite = event.eventInvites.find((invite) => invite.invitedProfile.id === user.player_id);

    if (!invite) throw new HTTPException(403);
    invite.status = c.req.param('decision') === 'accept' ? 'ACCEPTED' : 'REJECTED';
    save(event);

    return c.body(null, 204);
  });
  app.get('/api/notifications', (c) => {
    const user = authenticated(c);

    return c.json(
      db
        .prepare('SELECT json FROM notification WHERE player_id=?')
        .all(user.player_id)
        .flatMap((row) => {
          const text = z.string().parse(row.json);

          const notification = z.object({ argString0: z.string() }).parse(JSON.parse(text));

          return z.object({ eventStartDate: z.number() }).parse(JSON.parse(notification.argString0)).eventStartDate *
            1000 >
            Date.now() - 1_800_000
            ? text
            : [];
        }),
    );
  });
  app.put('/api/notifications/:id', async (c) => {
    const user = authenticated(c);

    const row = db
      .prepare('SELECT json FROM notification WHERE id=? AND player_id=?')
      .get(c.req.param('id'), user.player_id);

    if (!row) throw new HTTPException(404);

    const notification = z.record(z.string(), z.json()).parse(JSON.parse(z.string().parse(row.json)));

    const update = z.object({ read: z.boolean(), readDate: z.string().nullable() }).parse(await c.req.json());

    Object.assign(notification, update, { lastModified: update.readDate });
    db.prepare('UPDATE notification SET json=? WHERE id=?').run(JSON.stringify(notification), c.req.param('id'));

    return c.body(null, 204);
  });
  app.get('/relay/events/subgroups/:id/late-join', (c) => {
    const user = authenticated(c);
    const event = read(c.req.param('id'));

    if (!visible(event, user.player_id)) throw new HTTPException(403);

    const leader = [...runtime.world.online].find(
      ([id, state]) => id !== BigInt(user.player_id) && state.groupId === BigInt(event.id),
    );

    if (!leader) return c.body(null, 200);

    return c.body(
      toBinary(
        LateJoinInformationSchema,
        create(LateJoinInformationSchema, {
          roadId: BigInt(road(leader[1])),
          roadTime: (leader[1].roadTime - 5000) / 1_000_000,
          isForward: forward(leader[1]),
          organizerId: leader[0],
          ljF5: 0,
          ljF6: 0,
          ljF7: 0,
        }),
      ),
    );
  });
}
