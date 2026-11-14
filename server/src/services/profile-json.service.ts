import type { Attribute, PlayerProfile } from '#src/protocol/generated/profile_pb';
import {
  ActivityPrivacyType,
  AttributeSchema,
  PlayerProfile_EnrolledProgram,
  PlayerProfileSchema,
  PlayerType,
  PropertyChangeSchema,
} from '#src/protocol/generated/profile_pb';
import { BaseService } from '#src/services/base.service';
import { isFieldSet, toJson } from '@bufbuild/protobuf';
import { z } from 'zod';

function attributes(items: Attribute[]) {
  const result: Record<string, string | number> = {};

  for (const item of items) {
    if (isFieldSet(item, AttributeSchema.field.numberValue)) result[String(item.id)] = String(item.numberValue);

    if (isFieldSet(item, AttributeSchema.field.floatValue)) result[String(item.id)] = item.floatValue;

    if (isFieldSet(item, AttributeSchema.field.stringValue)) result[String(item.id)] = item.stringValue;
  }

  return result;
}

/** Companion JSON is a separate protocol from protobuf's standard JSON mapping. */

export class ProfileJsonService extends BaseService {
  static profileAge(profile: PlayerProfile) {
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(profile.dob);

    if (!match) return profile.age;

    const month = Number(match[1]),
      day = Number(match[2]),
      year = Number(match[3]);

    const birth = new Date(Date.UTC(year, month - 1, day));

    if (birth.getUTCFullYear() !== year || birth.getUTCMonth() !== month - 1 || birth.getUTCDate() !== day)
      return profile.age;
    const now = new Date();

    return (
      now.getUTCFullYear() -
      year -
      (now.getUTCMonth() + 1 < month || (now.getUTCMonth() + 1 === month && now.getUTCDate() < day) ? 1 : 0)
    );
  }

  static companionProfile(profile: PlayerProfile, avatar: string | null, bikeFrameName: string) {
    const privacy = profile.privacyBits;

    const result = {
      id: Number(profile.id),
      firstName: isFieldSet(profile, PlayerProfileSchema.field.firstName) ? profile.firstName : null,
      lastName: isFieldSet(profile, PlayerProfileSchema.field.lastName) ? profile.lastName : null,
      preferredLanguage: isFieldSet(profile, PlayerProfileSchema.field.preferredLanguage)
        ? profile.preferredLanguage
        : null,
      bodyType: isFieldSet(profile, PlayerProfileSchema.field.bodyType) ? profile.bodyType : 0,
      male: !isFieldSet(profile, PlayerProfileSchema.field.isMale) || profile.isMale,
      imageSrc: avatar,
      imageSrcLarge: avatar,
      playerType: PlayerType[isFieldSet(profile, PlayerProfileSchema.field.playerType) ? profile.playerType : 1],
      playerTypeId: isFieldSet(profile, PlayerProfileSchema.field.playerType) ? profile.playerType : 1,
      playerSubTypeId: null,
      emailAddress: isFieldSet(profile, PlayerProfileSchema.field.email) ? profile.email : null,
      countryCode: isFieldSet(profile, PlayerProfileSchema.field.countryCode) ? profile.countryCode : null,
      dob: isFieldSet(profile, PlayerProfileSchema.field.dob) ? profile.dob : null,
      countryAlpha3: 'rus',
      useMetric: !isFieldSet(profile, PlayerProfileSchema.field.useMetric) || profile.useMetric,
      privacy: {
        approvalRequired: !!(privacy & 1n),
        displayWeight: !!(privacy & 4n),
        minor: !!(privacy & 2n),
        privateMessaging: !!(privacy & 8n),
        defaultFitnessDataPrivacy: !!(privacy & 16n),
        suppressFollowerNotification: !!(privacy & 32n),
        displayAge: !(privacy & 64n),
        defaultActivityPrivacy: ActivityPrivacyType[profile.defaultActivityPrivacy],
      },
      age: ProfileJsonService.profileAge(profile),
      ftp: isFieldSet(profile, PlayerProfileSchema.field.ftp) ? profile.ftp : null,
      b: false,
      weight: isFieldSet(profile, PlayerProfileSchema.field.weightInGrams) ? profile.weightInGrams : null,
      height: isFieldSet(profile, PlayerProfileSchema.field.heightInMillimeters) ? profile.heightInMillimeters : null,
      connectedToStrava: profile.connectedToStrava,
      connectedToTrainingPeaks: profile.connectedToTrainingPeaks,
      connectedToTodaysPlan: profile.connectedToTodaysPlan,
      connectedToUnderArmour: profile.connectedToUnderArmour,
      connectedToFitbit: profile.connectedToFitbit,
      connectedToGarmin: profile.connectedToGarmin,
      totalExperiencePoints: isFieldSet(profile, PlayerProfileSchema.field.totalXp) ? profile.totalXp : 0,
      worldId: isFieldSet(profile, PlayerProfileSchema.field.serverRealm)
        ? z.number().int().safe().parse(Number(profile.serverRealm))
        : null,
      totalDistance: isFieldSet(profile, PlayerProfileSchema.field.totalDistanceInMeters)
        ? profile.totalDistanceInMeters
        : 0,
      totalDistanceClimbed: isFieldSet(profile, PlayerProfileSchema.field.elevationGainInMeters)
        ? profile.elevationGainInMeters
        : 0,
      totalTimeInMinutes: isFieldSet(profile, PlayerProfileSchema.field.timeRiddenInMinutes)
        ? profile.timeRiddenInMinutes
        : 0,
      achievementLevel: isFieldSet(profile, PlayerProfileSchema.field.achievementLevel) ? profile.achievementLevel : 0,
      totalWattHours: isFieldSet(profile, PlayerProfileSchema.field.totalWattHours) ? profile.totalWattHours : 0,
      runTime1miInSeconds: isFieldSet(profile, PlayerProfileSchema.field.runTime1miInSeconds)
        ? profile.runTime1miInSeconds
        : 0,
      runTime5kmInSeconds: isFieldSet(profile, PlayerProfileSchema.field.runTime5kmInSeconds)
        ? profile.runTime5kmInSeconds
        : 0,
      runTime10kmInSeconds: isFieldSet(profile, PlayerProfileSchema.field.runTime10kmInSeconds)
        ? profile.runTime10kmInSeconds
        : 0,
      runTimeHalfMarathonInSeconds: isFieldSet(profile, PlayerProfileSchema.field.runTimeHalfMarathonInSeconds)
        ? profile.runTimeHalfMarathonInSeconds
        : 0,
      runTimeFullMarathonInSeconds: isFieldSet(profile, PlayerProfileSchema.field.runTimeFullMarathonInSeconds)
        ? profile.runTimeFullMarathonInSeconds
        : 0,
      totalInKomJersey: isFieldSet(profile, PlayerProfileSchema.field.totalInKomJersey) ? profile.totalInKomJersey : 0,
      totalInSprintersJersey: isFieldSet(profile, PlayerProfileSchema.field.totalInSprintersJersey)
        ? profile.totalInSprintersJersey
        : 0,
      totalInOrangeJersey: isFieldSet(profile, PlayerProfileSchema.field.totalInOrangeJersey)
        ? profile.totalInOrangeJersey
        : 0,
      currentActivityId: isFieldSet(profile, PlayerProfileSchema.field.currentActivityId)
        ? z.number().int().safe().parse(Number(profile.currentActivityId))
        : null,
      enrolledZwiftAcademy: profile.enrolledProgram === PlayerProfile_EnrolledProgram.ZWIFT_ACADEMY,
      runAchievementLevel: isFieldSet(profile, PlayerProfileSchema.field.runAchievementLevel)
        ? profile.runAchievementLevel
        : 0,
      totalRunDistance: isFieldSet(profile, PlayerProfileSchema.field.totalRunDistance) ? profile.totalRunDistance : 0,
      totalRunTimeInMinutes: isFieldSet(profile, PlayerProfileSchema.field.totalRunTimeInMinutes)
        ? profile.totalRunTimeInMinutes
        : 0,
      totalRunExperiencePoints: isFieldSet(profile, PlayerProfileSchema.field.totalRunExperiencePoints)
        ? profile.totalRunExperiencePoints
        : 0,
      totalRunCalories: isFieldSet(profile, PlayerProfileSchema.field.totalRunCalories) ? profile.totalRunCalories : 0,
      totalGold: isFieldSet(profile, PlayerProfileSchema.field.totalGoldDrops) ? profile.totalGoldDrops : 0,
      profilePropertyChanges:
        profile.propertyChanges.length > 0
          ? profile.propertyChanges.map((item) => toJson(PropertyChangeSchema, item))
          : null,
      cyclingOrganization: isFieldSet(profile, PlayerProfileSchema.field.cyclingOrganization)
        ? profile.cyclingOrganization
        : null,
      stravaPremium: profile.stravaPremium,
      profileChanges: false,
      userAgent: 'CNL/3.13.0 (Android 11) zwift/1.0.85684 curl/7.78.0-DEV',
      launchedGameClient: '09/19/2021 13:24:19 +0000',
      createdOn: '2021-09-19T13:24:17.783+0000',
      bt: 'f97803d3-efac-4510-a17a-ef44e65d3071',
      virtualBikeModel: bikeFrameName,
      publicAttributes: attributes(profile.publicAttributes),
      privateAttributes: attributes(profile.privateAttributes),
      likelyInGame: false,
      address: null,
      numberOfFolloweesInCommon: 0,
      fundraiserId: null,
      source: 'Android',
      origin: null,
      licenseNumber: null,
      bigCommerceId: null,
      marketingConsent: null,
      affiliate: null,
      avantlinkId: null,
      connectedToWithings: profile.connectedToWithings,
      connectedToRuntastic: profile.connectedToRuntastic,
      connectedToZwiftPower: false,
      powerSourceType: 'Power Source',
      powerSourceModel: profile.powerSourceModel === 1 ? 'Power Meter' : 'zPower',
      riding: false,
      location: '',
      publicId: profile.publicId,
      mixpanelDistinctId: profile.mixPanelDistinctId,
    };

    return result;
  }
}
