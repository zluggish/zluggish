import type { PlayerProfile } from '#src/protocol/generated/profile_pb';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import type { AccountsRepository } from '#src/repositories/accounts.repository';
import { writeDurable } from '#src/repositories/files.repository';
import { clone, create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { randomUUID } from '#src/repositories/crypto.repository';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export class Profiles {
  readonly synthetic = new Map<bigint, PlayerProfile>();
  constructor(
    readonly storage: string,
    private readonly accounts: AccountsRepository,
  ) {}

  folder(id: number) {
    return resolve(this.storage, String(id));
  }

  get(id: number): PlayerProfile {
    const synthetic = this.synthetic.get(BigInt(id));

    if (synthetic) return clone(PlayerProfileSchema, synthetic);
    const path = resolve(this.folder(id), 'profile.bin');

    if (existsSync(path)) {
      const profile = fromBinary(PlayerProfileSchema, readFileSync(path));
      profile.id = BigInt(id);

      return profile;
    }

    const user = this.accounts.get(id);

    if (!user) throw new Error('Unknown rider');

    return create(PlayerProfileSchema, {
      id: BigInt(id),
      firstName: user.first_name,
      email: user.username,
      mixPanelDistinctId: randomUUID(),
      lastName: user.last_name,
      isMale: true,
      useMetric: true,
      weightInGrams: 75_000,
      heightInMillimeters: 1800,
      countryCode: 0,
    });
  }

  save(id: number, profile: PlayerProfile) {
    profile.id = BigInt(id);
    writeDurable(resolve(this.folder(id), 'profile.bin'), toBinary(PlayerProfileSchema, profile), true);
    this.accounts.updateName(id, profile.firstName, profile.lastName);
  }
}
