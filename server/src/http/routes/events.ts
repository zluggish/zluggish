import { notificationPayloadSchema, notificationEventSchema, notificationUpdateSchema } from '#src/dtos/events.dto';
import { inputSchema, type Meetup } from '#src/dtos/meetup.dto';
import { authenticated } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import {
  EventsSchema,
  LateJoinInformationSchema,
  PrivateEventFeedListProtoSchema,
  PrivateEventFeedProtoSchema,
  PrivateEventProtoSchema,
} from '#src/protocol/generated/events_pb';
import { forward, road } from '#src/world/state';
import { create, toBinary } from '@bufbuild/protobuf';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

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

export function eventRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const service = runtime.services.events;

  app.get('/api/event-feed', (c) =>
    c.json({
      data: runtime.services.events
        .eventsAt(runtime.assets, limit(c.req.query('limit')), c.req.query('sport'))
        .map((event) => ({
          event: runtime.services.events.eventJSON(event),
        })),
      cursor: null,
    }),
  );
  app.post('/api/events/search', (c) => {
    const events = runtime.services.events.eventsAt(runtime.assets, limit(c.req.query('limit')));

    return c.req.header('Accept')?.includes('application/json')
      ? c.json(events.map((event) => runtime.services.events.eventJSON(event)))
      : c.body(toBinary(EventsSchema, create(EventsSchema, { events })));
  });
  app.get('/api/events/:id', (c) => {
    const event = runtime.services.events
      .eventsAt(runtime.assets)
      .find((item) => item.id === BigInt(c.req.param('id')));

    return event ? c.json(runtime.services.events.eventJSON(event)) : c.body(null, 200);
  });
  app.on(['POST', 'DELETE'], ['/api/events/subgroups/signup/:id', '/api/events/signup/:id'], (c) => {
    const user = authenticated(c);
    const joining = c.req.method === 'POST';
    const id = BigInt(c.req.param('id'));

    service.announceSignup(user.player_id, id, joining);

    return c.json({ signedUp: joining });
  });
  app.get('/api/private_event/feed', (c) => {
    const user = authenticated(c);
    let start = Number(c.req.query('start_date') ?? 0);

    if (start === -1_800_000) start += Date.now();

    const events = service
      .all()
      .filter(
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
    const id = service.createMeetup(user, input);

    return c.json({ id }, 201);
  });
  app.on(['GET', 'PUT', 'DELETE'], '/api/private_event/:id{[0-9]+}', async (c) => {
    const user = authenticated(c);
    const event = service.read(c.req.param('id'));

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
      service.deleteMeetup(event);

      return c.body(null, 200);
    }

    const update = inputSchema.parse(await c.req.json());

    service.updateMeetup(event, update);

    return c.json({ id: event.id });
  });
  app.put('/api/private_event/:id{[0-9]+}/:decision{accept|reject}', (c) => {
    const user = authenticated(c);
    const event = service.read(c.req.param('id'));

    service.respondToInvite(event, user.player_id, c.req.param('decision') === 'accept');

    return c.body(null, 204);
  });
  app.get('/api/notifications', (c) => {
    const user = authenticated(c);

    return c.json(
      service.notificationsForPlayer(user.player_id).flatMap((row) => {
        const text = z.string().parse(row.json);

        const notification = notificationPayloadSchema.parse(JSON.parse(text));

        return notificationEventSchema.parse(JSON.parse(notification.argString0)).eventStartDate * 1000 >
          Date.now() - 1_800_000
          ? text
          : [];
      }),
    );
  });
  app.put('/api/notifications/:id', async (c) => {
    const user = authenticated(c);

    const row = service.findNotification(c.req.param('id'), user.player_id);

    if (!row) throw new HTTPException(404);

    const notification = z.record(z.string(), z.json()).parse(JSON.parse(z.string().parse(row.json)));

    const update = notificationUpdateSchema.parse(await c.req.json());

    Object.assign(notification, update, { lastModified: update.readDate });
    service.updateNotification(JSON.stringify(notification), c.req.param('id'));

    return c.body(null, 204);
  });
  app.get('/relay/events/subgroups/:id{[0-9]+}/late-join', (c) => {
    const user = authenticated(c);
    const event = service.read(c.req.param('id'));

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
