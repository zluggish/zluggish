import type { RepositoryContext } from '#src/context';
import {
  PlayerProfileSchema,
  ProfileEntitlement_EntitlementType,
  ProfileEntitlement_ProfileEntitlementStatus,
  ProfileEntitlementSchema,
} from '#src/protocol/generated/profile_pb';
import { readFileSync } from '#src/repositories/files.repository';
import { companionProfile } from '#src/repositories/profile-json.repository';
import type { Profiles } from '#src/repositories/profile.repository';
import { create } from '@bufbuild/protobuf';
import { resolve } from 'node:path';
import { z } from 'zod';

export class ProfilesService {
  constructor(
    private readonly repository: Profiles,
    private readonly context: RepositoryContext,
  ) {}
  folder(...args: Parameters<Profiles['folder']>) {
    return this.repository.folder(...args);
  }
  get(...args: Parameters<Profiles['get']>) {
    return this.repository.get(...args);
  }
  save(...args: Parameters<Profiles['save']>) {
    return this.repository.save(...args);
  }
  get synthetic() {
    return this.repository.synthetic;
  }

  companionProfile(...args: Parameters<typeof companionProfile>) {
    return companionProfile(...args);
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
        .parse(JSON.parse(readFileSync(resolve(this.context.assets, 'data/entitlements.txt'), 'utf8')));

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
