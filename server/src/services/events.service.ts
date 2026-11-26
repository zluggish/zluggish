import { t } from '#src/i18n/index';
import { RuntimeContext } from '#src/context';
import type { notificationUpdateSchema } from '#src/dtos/events.dto';
import { notificationPayloadSchema, notificationEventSchema } from '#src/dtos/events.dto';
import type { Meetup, MeetupInput } from '#src/dtos/meetup.dto';
import { decodeMeetup } from '#src/dtos/meetup.dto';
import { ApplicationError } from '#src/errors';
import { EventSchema, PlayerJoinedEventSchema, PlayerLeftEventSchema } from '#src/protocol/generated/events_pb';
import { WA_TYPE, WorldAttributeSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import type { User } from '#src/repositories/accounts.repository';
import type { EventsRepository } from '#src/repositories/events.repository';
import { EventCatalogService } from '#src/services/event-catalog.service';
import { worldTime } from '#src/world/state';
import { create, toBinary } from '@bufbuild/protobuf';
import { transaction } from '#src/db/transaction';
import { Context, Effect, Layer, Schema } from 'effect';

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const repositories = context.accounts.repositories;
  const eventCatalogService = yield* EventCatalogService;

  const findPrivateEvent = Effect.fn('EventsService.findPrivateEvent')(function* (
    ...values: Parameters<EventsRepository['findPrivateEvent']>
  ) {
    return repositories.eventsRepository.findPrivateEvent(...values);
  });

  const updateNotification = Effect.fn('EventsService.updateNotification')(function* (
    ...values: Parameters<EventsRepository['updateNotification']>
  ) {
    return repositories.eventsRepository.updateNotification(...values);
  });

  const notificationsForPlayer = Effect.fn('EventsService.notificationsForPlayer')(function* (
    ...values: Parameters<EventsRepository['notificationsForPlayer']>
  ) {
    return repositories.eventsRepository.notificationsForPlayer(...values);
  });

  const findNotification = Effect.fn('EventsService.findNotification')(function* (
    ...values: Parameters<EventsRepository['findNotification']>
  ) {
    return repositories.eventsRepository.findNotification(...values);
  });

  /** Listing expiry only hides notifications. Updates can mark read or unread;
  meetup edits reset unread and invite removal deletes the corresponding rows.
  */
  const notifications = Effect.fn('EventsService.notifications')(function* (player: number, now = Date.now()) {
    return (yield* notificationsForPlayer(player)).flatMap((row) => {
      const text = Schema.decodeUnknownSync(Schema.String)(row.json);
      const notification = Schema.decodeUnknownSync(notificationPayloadSchema)(JSON.parse(text));

      return Schema.decodeUnknownSync(notificationEventSchema)(JSON.parse(notification.argString0)).eventStartDate *
        1000 >
        now - 1_800_000
        ? text
        : [];
    });
  });

  const markNotification = Effect.fn('EventsService.markNotification')(function* (
    player: number,
    id: string,
    update: (typeof notificationUpdateSchema)['Type'],
  ) {
    const row = yield* findNotification(id, player);

    if (!row) {
      return yield* new ApplicationError({ status: 404 });
    }

    const notification = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
      JSON.parse(Schema.decodeUnknownSync(Schema.String)(row.json)),
    );

    Object.assign(notification, update, { lastModified: update.readDate });
    yield* updateNotification(JSON.stringify(notification), id);
  });

  function profileOf(id: number) {
    const rider = context.profiles.get(id);

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

  const profile = Effect.fn('EventsService.profile')(function* (id: number) {
    return profileOf(id);
  });

  const read = Effect.fn('EventsService.read')(function* (id: string) {
    const row = yield* findPrivateEvent(id);

    if (!row) {
      return yield* new ApplicationError({ status: 404 });
    }

    return decodeMeetup(JSON.parse(Schema.decodeUnknownSync(Schema.String)(row.json)));
  });

  const all = Effect.fn('EventsService.all')(function* () {
    return repositories.eventsRepository
      .listPrivateEvent()
      .map((row) => decodeMeetup(JSON.parse(Schema.decodeUnknownSync(Schema.String)(row.json))));
  });

  /** Store a meetup with its invite counts. Runs inside the caller's transaction. */
  function saveEvent(event: Meetup) {
    const accepted = event.eventInvites.filter((invite) => invite.status === 'ACCEPTED');
    event.acceptedTotalCount = accepted.length;
    event.acceptedFolloweeCount = accepted.filter(
      (invite) => invite.invitedProfile.id !== event.organizerProfileId,
    ).length;
    event.invitedTotalCount = event.eventInvites.length;
    repositories.eventsRepository.updatePrivateEvent(JSON.stringify(event), event.id);
  }

  const save = Effect.fn('EventsService.save')(function* (event: Meetup) {
    saveEvent(event);
  });

  const broadcast = Effect.fn('EventsService.broadcast')(function* (event: Meetup) {
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

    for (const id of recipients) {
      context.world.enqueue(
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
  });

  const notify = Effect.fn('EventsService.notify')(function* (event: Meetup, id: number) {
    const notificationId = Number(repositories.eventsRepository.insertNotification(event.id, id, '').lastInsertRowid);

    const organizer = yield* profile(event.organizerProfileId);

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

    yield* updateNotification(JSON.stringify(notification), notificationId);
  });

  const announceSignup = Effect.fn('EventsService.announceSignup')(function* (
    playerId: number,
    id: bigint,
    joining: boolean,
  ) {
    const payload = joining
      ? toBinary(
          PlayerJoinedEventSchema,
          create(PlayerJoinedEventSchema, {
            relId: id,
            playerId: BigInt(playerId),
          }),
        )
      : toBinary(
          PlayerLeftEventSchema,
          create(PlayerLeftEventSchema, {
            relId: id,
            playerId: BigInt(playerId),
          }),
        );

    context.world.enqueue(
      create(WorldAttributeSchema, {
        serverRealm: 1n,
        waType: joining ? WA_TYPE.WAT_JOIN_E : WA_TYPE.WAT_LEFT_E,
        payload,
        worldTimeBorn: worldTime(),
        worldTimeExpire: worldTime() + 60_000n,
        waF12: 1n,
        timestamp: BigInt(Date.now()) * 1000n,
        relId: BigInt(playerId),
      }),
      [...new Set([...context.world.online.keys(), BigInt(playerId)])],
    );
  });

  const eventsAt = Effect.fn('EventsService.eventsAt')(function* (
    ...args: Parameters<EventCatalogService['Service']['eventsAt']>
  ) {
    return yield* eventCatalogService.eventsAt(...args);
  });

  const eventJSON = Effect.fn('EventsService.eventJSON')(function* (
    ...args: Parameters<typeof EventCatalogService.eventJSON>
  ) {
    return EventCatalogService.eventJSON(...args);
  });

  const createMeetup = Effect.fn('EventsService.createMeetup')(function* (user: User, input: MeetupInput) {
    input.invitedProfileIds = [...new Set(input.invitedProfileIds)].filter((id) => id !== user.player_id);

    for (const id of input.invitedProfileIds) {
      if (!context.accounts.get(id)) {
        return yield* new ApplicationError({ status: 400 });
      }
    }

    const event = yield* transaction(context.accounts.db)(
      Effect.gen(function* () {
        const id = Number(repositories.eventsRepository.insertPrivateEvent('{}').lastInsertRowid);

        const organizer = profileOf(user.player_id);

        const event: Meetup = {
          ...input,
          id,
          eventSubgroupId: id,
          name: t('route', { value1: input.routeId }),
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
              invitedProfile: profileOf(id),
              status: Schema.decodeUnknownSync(Schema.Literal('PENDING'))('PENDING'),
            })),
          ],
        };

        saveEvent(event);

        for (const id of input.invitedProfileIds) {
          yield* notify(event, id);
        }

        return event;
      }),
    );

    yield* announceSignup(user.player_id, BigInt(event.id), true);
    yield* broadcast(event);

    return event.id;
  });

  const deleteMeetup = Effect.fn('EventsService.deleteMeetup')(function* (
    event: Meetup,
    commit: () => void = () => {},
  ) {
    yield* transaction(context.accounts.db)(
      Effect.sync(() => {
        repositories.eventsRepository.deletePrivateEvent(event.id);
        repositories.eventsRepository.deleteNotification(event.id);
        commit();
      }),
    );
  });

  const updateMeetup = Effect.fn('EventsService.updateMeetup')(function* (
    event: Meetup,
    update: MeetupInput,
    commit: () => void = () => {},
  ) {
    update.invitedProfileIds = [...new Set(update.invitedProfileIds)].filter((id) => id !== event.organizerProfileId);

    for (const id of update.invitedProfileIds) {
      if (!context.accounts.get(id)) {
        return yield* new ApplicationError({ status: 400 });
      }
    }
    const next = { ...event, ...update, updateDate: new Date().toISOString() };
    next.eventInvites = [
      { invitedProfile: profileOf(event.organizerProfileId), status: 'ACCEPTED' },
      ...update.invitedProfileIds
        .filter((id) => id !== event.organizerProfileId)
        .map(
          (id) =>
            event.eventInvites.find((invite) => invite.invitedProfile.id === id) ?? {
              invitedProfile: profileOf(id),
              status: Schema.decodeUnknownSync(Schema.Literal('PENDING'))('PENDING'),
            },
        ),
    ];
    yield* transaction(context.accounts.db)(
      Effect.gen(function* () {
        saveEvent(next);

        for (const row of repositories.eventsRepository.listNotification(event.id)) {
          if (!update.invitedProfileIds.includes(Schema.decodeUnknownSync(Schema.Finite)(row.player_id))) {
            repositories.eventsRepository.deletePlayerNotification(
              event.id,
              Schema.decodeUnknownSync(Schema.Finite)(row.player_id),
            );
            continue;
          }

          const notification = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
            JSON.parse(Schema.decodeUnknownSync(Schema.String)(row.json)),
          );

          Object.assign(notification, {
            read: false,
            readDate: null,
            lastModified: next.updateDate,
            argString0: JSON.stringify({
              eventId: next.id,
              eventStartDate: Math.floor(Date.parse(next.eventStart) / 1000),
              otherInviteeCount: next.invitedProfileIds.length,
            }),
          });
          yield* updateNotification(JSON.stringify(notification), Schema.decodeUnknownSync(Schema.Finite)(row.id));
        }

        for (const id of update.invitedProfileIds) {
          if (!event.invitedProfileIds.includes(id)) {
            yield* notify(next, id);
          }
        }
        commit();
      }),
    );

    yield* broadcast(next);
  });

  // Any existing decision may change. The organizer remains accepted when updating
  // the invite list; retained invitees keep decisions, new invitees start pending.
  const respondToInvite = Effect.fn('EventsService.respondToInvite')(function* (
    event: Meetup,
    playerId: number,
    accepting: boolean,
  ) {
    const invite = event.eventInvites.find((invite) => invite.invitedProfile.id === playerId);

    if (!invite) {
      return yield* new ApplicationError({ status: 403 });
    }
    invite.status = accepting ? 'ACCEPTED' : 'REJECTED';
    saveEvent(event);
  });

  return {
    findPrivateEvent,
    updateNotification,
    notificationsForPlayer,
    findNotification,
    notifications,
    markNotification,
    profile,
    read,
    all,
    save,
    broadcast,
    notify,
    announceSignup,
    eventsAt,
    eventJSON,
    createMeetup,
    deleteMeetup,
    updateMeetup,
    respondToInvite,
  };
});

export class EventsService extends Context.Service<EventsService, Effect.Success<typeof make>>()(
  'zluggish/EventsService',
) {
  static readonly layer = Layer.effect(EventsService, make);
}
