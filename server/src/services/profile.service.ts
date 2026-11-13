import type { RepositoryContext } from '#src/context';
import {
  PlayerProfileSchema,
  ProfileEntitlement_EntitlementType,
  ProfileEntitlement_ProfileEntitlementStatus,
  ProfileEntitlementSchema,
} from '#src/protocol/generated/profile_pb';
import type { Profiles } from '#src/repositories/profile.repository';
import { BaseService } from '#src/services/base.service';
import { ProfileJsonService } from '#src/services/profile-json.service';
import { create } from '@bufbuild/protobuf';
import { resolve } from 'node:path';
import { z } from 'zod';

export class ProfilesService extends BaseService {
  constructor(private readonly context: RepositoryContext) {
    super(context.accounts.repositories);
  }
  folder(...args: Parameters<Profiles['folder']>) {
    return this.profileRepository.folder(...args);
  }
  get(...args: Parameters<Profiles['get']>) {
    return this.profileRepository.get(...args);
  }
  save(...args: Parameters<Profiles['save']>) {
    return this.profileRepository.save(...args);
  }
  get synthetic() {
    return this.profileRepository.synthetic;
  }

  forViewer(profile: ReturnType<typeof create<typeof PlayerProfileSchema>>, viewer?: number) {
    if (viewer !== undefined && profile.id === BigInt(viewer)) return profile;

    const publicProfile = create(PlayerProfileSchema, {
      id: profile.id,
      firstName: profile.firstName,
      lastName: profile.lastName,
      isMale: profile.isMale,
      countryCode: profile.countryCode,
      playerType: profile.playerType,
      largeAvatarUrl: profile.largeAvatarUrl,
      privacyBits: profile.privacyBits,
      bodyType: profile.bodyType,
      hairType: profile.hairType,
      hairColour: profile.hairColour,
      facialHairType: profile.facialHairType,
      facialHairColour: profile.facialHairColour,
      rideHelmetType: profile.rideHelmetType,
      glassesType: profile.glassesType,
      rideShoesType: profile.rideShoesType,
      rideSocksType: profile.rideSocksType,
      rideSocksLength: profile.rideSocksLength,
      rideGloves: profile.rideGloves,
      rideJersey: profile.rideJersey,
      bikeFrame: profile.bikeFrame,
      bikeFrameColour: profile.bikeFrameColour,
      bikeWheelFront: profile.bikeWheelFront,
      bikeWheelRear: profile.bikeWheelRear,
      runShirtType: profile.runShirtType,
      runShortsType: profile.runShortsType,
      runShortsLength: profile.runShortsLength,
      runShoesType: profile.runShoesType,
      runSocksType: profile.runSocksType,
      runSocksLength: profile.runSocksLength,
      runHelmetType: profile.runHelmetType,
      runArmAccessory: profile.runArmAccessory,
      achievementLevel: profile.achievementLevel,
      runAchievementLevel: profile.runAchievementLevel,
    });

    if (profile.privacyBits & 4n) publicProfile.weightInGrams = profile.weightInGrams;

    if (!(profile.privacyBits & 64n)) publicProfile.age = ProfileJsonService.profileAge(profile);

    return publicProfile;
  }
  companionProfile(...args: [Parameters<typeof ProfileJsonService.companionProfile>[0], string | null]) {
    return ProfileJsonService.companionProfile(...args, this.profileJsonRepository.bikeFrameName(args[0].bikeFrame));
  }
  entitlements(profile: ReturnType<typeof create<typeof PlayerProfileSchema>>) {
    profile.entitlements = profile.entitlements.filter((item) => item.type !== ProfileEntitlement_EntitlementType.RIDE);
    profile.entitlements.push(
      create(ProfileEntitlementSchema, {
        type: ProfileEntitlement_EntitlementType.RIDE,
        id: -1n,
        status: ProfileEntitlement_ProfileEntitlementStatus.ACTIVE,
      }),
    );

    if (this.context.config.equipment.unlockAll || this.context.config.equipment.unlockEntitlements) {
      const range = z
        .object({ first: z.number().int(), last: z.number().int() })
        .parse(
          JSON.parse(this.filesRepository.readFileSync(resolve(this.context.assets, 'data/entitlements.txt'), 'utf8')),
        );

      const owned = new Set(profile.entitlements.map((item) => item.id));

      for (let id = this.context.config.equipment.unlockAll ? 1 : range.first; id <= range.last; id++)
        if (!owned.has(BigInt(id)))
          profile.entitlements.push(
            create(ProfileEntitlementSchema, {
              id: BigInt(id),
              type: ProfileEntitlement_EntitlementType.USE,
              status: ProfileEntitlement_ProfileEntitlementStatus.ACTIVE,
            }),
          );
    }

    return profile;
  }
}
