import { toJsonString } from '@bufbuild/protobuf';
import { z } from 'zod';
import {
  PlayerProfileSchema,
  PlayerType,
  ActivityPrivacyType,
  PlayerProfile_EnrolledProgram,
} from '#src/protocol/generated/profile_pb';
import type { PlayerProfile } from '#src/protocol/generated/profile_pb';

type JsonValue = z.infer<ReturnType<typeof z.json>>;

/** Companion JSON is a separate protocol from protobuf's standard JSON mapping. */
export function companionProfile(profile: PlayerProfile, avatar: string | null) {
  const json = z
    .record(z.string(), z.json())
    .parse(JSON.parse(toJsonString(PlayerProfileSchema, profile, { enumAsInteger: true })));

  const field = (name: string, fallback: JsonValue = null): JsonValue => json[name] ?? fallback;

  const privacy = profile.privacyBits;

  const result = {
    id: Number(profile.id),
    firstName: field('firstName'),
    lastName: field('lastName'),
    preferredLanguage: field('preferredLanguage'),
    bodyType: field('bodyType', 0),
    male: field('isMale', true),
    imageSrc: avatar,
    imageSrcLarge: avatar,
    playerType: PlayerType[Number(field('playerType', 1))],
    playerTypeId: field('playerType', 1),
    playerSubTypeId: null,
    emailAddress: field('email'),
    countryCode: field('countryCode'),
    dob: field('dob'),
    countryAlpha3: 'rus',
    useMetric: field('useMetric', true),
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
    age: field('age', 0),
    ftp: field('ftp'),
    b: false,
    weight: field('weightInGrams'),
    height: field('heightInMillimeters'),
    connectedToStrava: field('connectedToStrava', false),
    connectedToTrainingPeaks: field('connectedToTrainingPeaks', false),
    connectedToTodaysPlan: field('connectedToTodaysPlan', false),
    connectedToUnderArmour: field('connectedToUnderArmour', false),
    connectedToFitbit: field('connectedToFitbit', false),
    connectedToGarmin: field('connectedToGarmin', false),
    totalExperiencePoints: field('totalXp', 0),
    worldId: field('serverRealm'),
    totalDistance: field('totalDistanceInMeters', 0),
    totalDistanceClimbed: field('elevationGainInMeters', 0),
    totalTimeInMinutes: field('timeRiddenInMinutes', 0),
    achievementLevel: field('achievementLevel', 0),
    totalWattHours: field('totalWattHours', 0),
    runTime1miInSeconds: field('runTime1miInSeconds', 0),
    runTime5kmInSeconds: field('runTime5kmInSeconds', 0),
    runTime10kmInSeconds: field('runTime10kmInSeconds', 0),
    runTimeHalfMarathonInSeconds: field('runTimeHalfMarathonInSeconds', 0),
    runTimeFullMarathonInSeconds: field('runTimeFullMarathonInSeconds', 0),
    totalInKomJersey: field('totalInKomJersey', 0),
    totalInSprintersJersey: field('totalInSprintersJersey', 0),
    totalInOrangeJersey: field('totalInOrangeJersey', 0),
    currentActivityId: field('currentActivityId'),
    enrolledZwiftAcademy: profile.enrolledProgram === PlayerProfile_EnrolledProgram.ZWIFT_ACADEMY,
    runAchievementLevel: field('runAchievementLevel', 0),
    totalRunDistance: field('totalRunDistance', 0),
    totalRunTimeInMinutes: field('totalRunTimeInMinutes', 0),
    totalRunExperiencePoints: field('totalRunExperiencePoints', 0),
    totalRunCalories: field('totalRunCalories', 0),
    totalGold: field('totalGoldDrops', 0),
    profilePropertyChanges: field('propertyChanges'),
    cyclingOrganization: field('cyclingOrganization'),
    stravaPremium: field('stravaPremium', false),
    profileChanges: false,
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
    connectedToWithings: field('connectedToWithings', false),
    connectedToRuntastic: field('connectedToRuntastic', false),
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
