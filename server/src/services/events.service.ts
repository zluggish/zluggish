import { notificationPayloadSchema, notificationEventSchema, notificationUpdateSchema } from '#src/dtos/events.dto';
import { type RepositoryContext } from '#src/context';
import type { Meetup, MeetupInput } from '#src/dtos/meetup.dto';
import { storedSchema } from '#src/dtos/meetup.dto';
import { ApplicationError } from '#src/errors';
import { EventSchema, PlayerJoinedEventSchema, PlayerLeftEventSchema } from '#src/protocol/generated/events_pb';
import { WA_TYPE, WorldAttributeSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import type { Rider } from '#src/repositories/accounts.repository';
import { EventsRepository } from '#src/repositories/events.repository';
import { BaseService } from '#src/services/base.service';
import { EventCatalogService } from '#src/services/event-catalog.service';
import { worldTime } from '#src/world/state';
import { create, toBinary } from '@bufbuild/protobuf';
import { z } from 'zod';

export class EventsService extends BaseService {
  constructor(private readonly context: RepositoryContext) {
    super(context.accounts.repositories);
  }
  findPrivateEvent(...values: Parameters<EventsRepository['findPrivateEvent']>) {
    return this.eventsRepository.findPrivateEvent(...values);
  }

  updateNotification(...values: Parameters<EventsRepository['updateNotification']>) {
    return this.eventsRepository.updateNotification(...values);
  }

  notificationsForPlayer(...values: Parameters<EventsRepository['notificationsForPlayer']>) {
    return this.eventsRepository.notificationsForPlayer(...values);
  }
  findNotification(...values: Parameters<EventsRepository['findNotification']>) {
    return this.eventsRepository.findNotification(...values);
  }

  /** Listing expiry only hides notifications. Updates can mark read or unread;
  meetup edits reset unread and invite removal deletes the corresponding rows.
  */
  notifications(player: number, now = Date.now()) {
    return this.notificationsForPlayer(player).flatMap((row) => {
      const text = z.string().parse(row.json);
      const notification = notificationPayloadSchema.parse(JSON.parse(text));

      return notificationEventSchema.parse(JSON.parse(notification.argString0)).eventStartDate * 1000 > now - 1_800_000
        ? text
        : [];
    });
  }
  markNotification(player: number, id: string, update: z.infer<typeof notificationUpdateSchema>) {
    const row = this.findNotification(id, player);

    if (!row) throw new ApplicationError(404);
    const notification = z.record(z.string(), z.json()).parse(JSON.parse(z.string().parse(row.json)));
    Object.assign(notification, update, { lastModified: update.readDate });
    this.updateNotification(JSON.stringify(notification), id);
  }

  profile(id: number) {
    const rider = this.context.profiles.get(id);

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
  read(id: string) {
    const row = this.findPrivateEvent(id);

    if (!row) throw new ApplicationError(404);

    return storedSchema.parse(JSON.parse(z.string().parse(row.json)));
  }
  all() {
    return this.eventsRepository
      .listPrivateEvent()
      .map((row) => storedSchema.parse(JSON.parse(z.string().parse(row.json))));
  }
  save(event: Meetup) {
    const accepted = event.eventInvites.filter((invite) => invite.status === 'ACCEPTED');
    event.acceptedTotalCount = accepted.length;
    event.acceptedFolloweeCount = accepted.filter(
      (invite) => invite.invitedProfile.id !== event.organizerProfileId,
    ).length;
    event.invitedTotalCount = event.eventInvites.length;
    this.eventsRepository.updatePrivateEvent(JSON.stringify(event), event.id);
  }
  broadcast(event: Meetup) {
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
      this.context.world.enqueue(
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
  notify(event: Meetup, id: number) {
    const notificationId = Number(this.eventsRepository.insertNotification(event.id, id, '').lastInsertRowid);

    const organizer = this.profile(event.organizerProfileId);

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

    this.updateNotification(JSON.stringify(notification), notificationId);
  }
  announceSignup(playerId: number, id: bigint, joining: boolean) {
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

    this.context.world.enqueue(
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
      [...new Set([...this.context.world.online.keys(), BigInt(playerId)])],
    );
  }

  private begin() {
    this.eventsRepository.begin();
  }
  private commit() {
    this.eventsRepository.commit();
  }
  private rollback() {
    this.eventsRepository.rollback();
  }

  eventsAt(...args: Parameters<EventCatalogService['eventsAt']>) {
    return new EventCatalogService(this.repositories).eventsAt(...args);
  }

  eventJSON(...args: Parameters<typeof EventCatalogService.eventJSON>) {
    return EventCatalogService.eventJSON(...args);
  }
  createMeetup(user: Rider, input: MeetupInput) {
    input.invitedProfileIds = [...new Set(input.invitedProfileIds)].filter((id) => id !== user.player_id);

    for (const id of input.invitedProfileIds) if (!this.context.accounts.get(id)) throw new ApplicationError(400);
    this.begin();
    let event: Meetup;

    try {
      const id = Number(this.eventsRepository.insertPrivateEvent('{}').lastInsertRowid);

      const organizer = this.profile(user.player_id);
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
            invitedProfile: this.profile(id),
            status: z.literal('PENDING').parse('PENDING'),
          })),
        ],
      };
      this.save(event);

      for (const id of input.invitedProfileIds) this.notify(event, id);
      this.commit();
    } catch (error) {
      this.rollback();
      throw error;
    }

    this.announceSignup(user.player_id, BigInt(event.id), true);
    this.broadcast(event);

    return event.id;
  }
  deleteMeetup(event: Meetup) {
    this.begin();

    try {
      this.eventsRepository.deletePrivateEvent(event.id);
      this.eventsRepository.deleteNotification(event.id);
      this.commit();
    } catch (error) {
      this.rollback();
      throw error;
    }
  }
  updateMeetup(event: Meetup, update: MeetupInput) {
    update.invitedProfileIds = [...new Set(update.invitedProfileIds)].filter((id) => id !== event.organizerProfileId);

    for (const id of update.invitedProfileIds) if (!this.context.accounts.get(id)) throw new ApplicationError(400);
    const next = { ...event, ...update, updateDate: new Date().toISOString() };
    next.eventInvites = [
      { invitedProfile: this.profile(event.organizerProfileId), status: 'ACCEPTED' },
      ...update.invitedProfileIds
        .filter((id) => id !== event.organizerProfileId)
        .map(
          (id) =>
            event.eventInvites.find((invite) => invite.invitedProfile.id === id) ?? {
              invitedProfile: this.profile(id),
              status: z.literal('PENDING').parse('PENDING'),
            },
        ),
    ];
    this.begin();

    try {
      this.save(next);

      for (const row of this.eventsRepository.listNotification(event.id)) {
        if (!update.invitedProfileIds.includes(z.number().parse(row.player_id))) {
          this.eventsRepository.deletePlayerNotification(event.id, z.number().parse(row.player_id));
          continue;
        }

        const notification = z.record(z.string(), z.json()).parse(JSON.parse(z.string().parse(row.json)));
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
        this.updateNotification(JSON.stringify(notification), z.number().parse(row.id));
      }

      for (const id of update.invitedProfileIds) if (!event.invitedProfileIds.includes(id)) this.notify(next, id);
      this.commit();
    } catch (error) {
      this.rollback();
      throw error;
    }

    this.broadcast(next);
  }
  // Any existing decision may change. The organizer remains accepted when updating
  // the invite list; retained invitees keep decisions, new invitees start pending.
  respondToInvite(event: Meetup, playerId: number, accepting: boolean) {
    const invite = event.eventInvites.find((invite) => invite.invitedProfile.id === playerId);

    if (!invite) throw new ApplicationError(403);
    invite.status = accepting ? 'ACCEPTED' : 'REJECTED';
    this.save(event);
  }
}
