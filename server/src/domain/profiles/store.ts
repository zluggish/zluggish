import { randomUUID } from 'node:crypto';
import { clone, create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import type { PlayerProfile } from '#src/protocol/generated/profile_pb';
import { writeDurable } from '#src/node/persistence/files';
import type { Accounts } from '#src/domain/accounts/repository';

export class Profiles {
  readonly synthetic = new Map<bigint, PlayerProfile>();
  constructor(readonly accounts: Accounts) {}

  folder(id: number) {
    return resolve(this.accounts.storage, String(id));
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
    this.accounts.db
      .prepare('UPDATE user SET first_name=?,last_name=? WHERE player_id=?')
      .run(profile.firstName, profile.lastName, id);
  }
}
