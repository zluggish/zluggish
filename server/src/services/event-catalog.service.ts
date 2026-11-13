import type { Event } from '#src/protocol/generated/events_pb';
import { EventSchema, EventSubgroupProtobufSchema, EventType } from '#src/protocol/generated/events_pb';
import { BaseService } from '#src/services/base.service';
import { worldTime } from '#src/world/state';
import { create } from '@bufbuild/protobuf';

export class EventCatalogService extends BaseService {
  eventsAt(assets: string, limit = 1000, sport?: string) {
    const catalog = this.eventCatalogRepository.readEventCatalog(assets);

    const start = BigInt(Math.floor(Date.now() / 1000) * 1000 + 120_000);
    const time = worldTime() + 120_000n;

    return catalog
      .flatMap((item, index) => {
        if (sport && item.sport !== (sport === 'RUNNING' ? 1 : 0)) return [];
        const id = BigInt(1_000_010 + index * 10);

        const event = create(EventSchema, {
          id,
          serverRealm: 1n,
          name: item.name,
          routeId: BigInt(item.route),
          courseId: BigInt(item.course),
          sport: item.sport,
          lateJoinInMinutes: 30,
          eventStart: start,
          visible: true,
          overrideMapPreferences: false,
          invisibleToNonParticipants: false,
          description: 'Auto-generated event',
          distanceInMeters: item.distance,
          laps: 0,
          durationInSeconds: 0,
          eventType: EventType.RACE,
          eWtrl: false,
        });

        for (let category = 1; category <= 4; category++)
          event.category.push(
            create(EventSubgroupProtobufSchema, {
              id: id + BigInt(category),
              registrationEnd: start,
              registrationEndWT: time,
              eventSubgroupStart: start - 120_000n,
              eventSubgroupStartWT: time - 120_000n,
              routeId: BigInt(item.route),
              startLocation: BigInt(category),
              label: category,
              lateJoinInMinutes: 30,
              name: `Cat. ${'ABCD'[category - 1]}`,
              description: '#zwiftoffline',
              courseId: BigInt(item.course),
              paceType: 1,
              fromPaceValue: [4, 3, 2, 1][category - 1] ?? 1,
              toPaceValue: [15, 4, 3, 2][category - 1] ?? 2,
              distanceInMeters: item.distance,
              laps: 0,
              durationInSeconds: 0,
            }),
          );

        return [event];
      })
      .slice(0, limit);
  }
  static eventJSON(event: Event) {
    const timestamp = (time: bigint) => (time ? new Date(Number(time)).toISOString().replace('Z', '+0000') : null);

    const counts = {
      followeeEntrantCount: 0,
      totalEntrantCount: 0,
      followeeSignedUpCount: 0,
      totalSignedUpCount: 0,
      followeeJoinedCount: 0,
      totalJoinedCount: 0,
    };

    return {
      id: Number(event.id),
      worldId: Number(event.serverRealm),
      name: event.name,
      description: event.description,
      shortName: null,
      mapId: Number(event.courseId),
      shortDescription: null,
      imageUrl: event.imageUrl,
      routeId: Number(event.routeId),
      rulesId: Number(event.rulesId),
      rulesSet: ['ALLOWS_LATE_JOIN'],
      routeUrl: null,
      jerseyHash: Number(event.jerseyHash),
      bikeHash: null,
      visible: event.visible,
      overrideMapPreferences: event.overrideMapPreferences,
      eventStart: timestamp(event.eventStart),
      tags: [''],
      durationInSeconds: event.durationInSeconds,
      distanceInMeters: event.distanceInMeters,
      laps: event.laps,
      privateEvent: false,
      invisibleToNonParticipants: event.invisibleToNonParticipants,
      ...counts,
      eventSeries: null,
      auxiliaryUrl: '',
      imageS3Name: null,
      imageS3Bucket: null,
      sport: event.sport === 1 ? 'RUNNING' : 'CYCLING',
      cullingType: 'CULLING_EVERYBODY',
      recurring: true,
      recurringOffset: null,
      publishRecurring: true,
      parentId: null,
      type: `EVENT_TYPE_${EventType[event.eventType]}`,
      eventType: EventType[event.eventType],
      workoutHash: null,
      customUrl: '',
      restricted: false,
      unlisted: false,
      eventSecret: null,
      accessExpression: null,
      qualificationRuleIds: null,
      lateJoinInMinutes: event.lateJoinInMinutes,
      timeTrialOptions: null,
      microserviceName: null,
      microserviceExternalResourceId: null,
      microserviceEventVisibility: null,
      minGameVersion: null,
      recordable: true,
      imported: false,
      eventTemplateId: null,
      eventSubgroups: event.category.map((group) => ({
        id: Number(group.id),
        name: group.name,
        description: group.description,
        label: group.label,
        subgroupLabel: group.name.at(-1),
        rulesId: Number(group.rulesId),
        mapId: Number(group.courseId),
        routeId: Number(group.routeId),
        routeUrl: group.routeUrl,
        jerseyHash: Number(group.jerseyHash),
        bikeHash: Number(group.bikeHash),
        startLocation: Number(group.startLocation),
        invitedLeaders: group.invitedLeaders.map(Number),
        invitedSweepers: group.invitedSweepers.map(Number),
        paceType: group.paceType,
        fromPaceValue: group.fromPaceValue,
        toPaceValue: group.toPaceValue,
        fieldLimit: null,
        registrationStart: timestamp(group.registrationStart),
        registrationEnd: timestamp(group.registrationEnd),
        lineUpStart: timestamp(group.lineUpStart),
        lineUpEnd: timestamp(group.lineUpEnd),
        eventSubgroupStart: timestamp(group.eventSubgroupStart),
        durationInSeconds: group.durationInSeconds,
        laps: group.laps,
        distanceInMeters: group.distanceInMeters,
        signedUp: false,
        signupStatus: 1,
        registered: false,
        registrationStatus: 1,
        ...counts,
        auxiliaryUrl: '',
        rulesSet: ['ALLOWS_LATE_JOIN'],
        workoutHash: null,
        customUrl: group.customUrl,
        overrideMapPreferences: false,
        tags: [''],
        lateJoinInMinutes: group.lateJoinInMinutes,
        timeTrialOptions: null,
        qualificationRuleIds: null,
        accessValidationResult: null,
      })),
    };
  }
}
