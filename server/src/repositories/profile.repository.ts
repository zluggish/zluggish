import { t } from '#src/i18n/index';
import { atomic } from '#src/db/transaction';
import type { PlayerProfile } from '#src/protocol/generated/profile_pb';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import type { AccountsRepository } from '#src/repositories/accounts.repository';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import type { RiderDocuments } from '#src/repositories/rider-document.repository';
import { clone, create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export class Profiles {
  readonly synthetic = new Map<bigint, PlayerProfile>();

  private readonly replayOwners = new Map<bigint, number>();

  // Each committed change advances the source version and replaces the cache entry.
  private readonly cache = new Map<number, PlayerProfile>();

  private readonly versions = new Map<number, number>();

  constructor(
    readonly storage: string,
    private readonly db: DatabaseSync,
    private readonly accounts: AccountsRepository,
    private readonly documents: RiderDocuments,
  ) {}

  /** Media and replaceable exports stay in the rider folder. */
  folder(id: number) {
    return resolve(this.storage, String(id));
  }

  version(id: number) {
    return this.versions.get(id) ?? 0;
  }

  get(id: number): PlayerProfile {
    const synthetic = this.synthetic.get(BigInt(id));

    if (!synthetic) {
      return this.getStored(id);
    }

    const profile = clone(PlayerProfileSchema, synthetic);
    const ownerId = this.replayOwners.get(profile.id);

    if (ownerId !== undefined && this.exists(ownerId)) {
      const owner = this.getStored(ownerId);

      if (owner.privacyBits & 4n && owner.weightInGrams > 0) {
        profile.weightInGrams = owner.weightInGrams;
      }
    }

    return profile;
  }

  setReplayProfile(profile: PlayerProfile, ownerId: number | undefined) {
    this.synthetic.set(profile.id, profile);

    if (ownerId === undefined) {
      this.replayOwners.delete(profile.id);
    } else {
      this.replayOwners.set(profile.id, ownerId);
    }
  }

  deleteReplayProfile(id: bigint) {
    this.synthetic.delete(id);
    this.replayOwners.delete(id);
  }

  private getStored(id: number): PlayerProfile {
    const cached = this.cache.get(id);

    if (cached) {
      return clone(PlayerProfileSchema, cached);
    }
    const profile = this.decode(id, this.documents.get(id, 'profile.bin'));
    this.cache.set(id, profile);

    return clone(PlayerProfileSchema, profile);
  }

  /** Database reads are short lookups; the asynchronous form keeps session loads uniform. */
  load(id: number): Promise<PlayerProfile> {
    return Promise.try(() => this.get(id));
  }

  exists(id: number) {
    return this.documents.has(id, 'profile.bin');
  }

  private decode(id: number, bytes: Uint8Array | null) {
    if (bytes) {
      const profile = fromBinary(PlayerProfileSchema, bytes);
      profile.id = BigInt(id);

      return profile;
    }

    const user = this.accounts.get(id);

    if (!user) {
      throw new Error(t('unknown_rider'));
    }

    return create(PlayerProfileSchema, {
      id: BigInt(id),
      firstName: user.first_name,
      email: user.username,
      mixPanelDistinctId: new CryptoRepository().randomUUID(),
      lastName: user.last_name,
      isMale: true,
      useMetric: true,
      weightInGrams: 75_000,
      heightInMillimeters: 1800,
      countryCode: 0,
    });
  }

  /** The profile and the account names commit together: they cannot differ after a crash. */
  save(id: number, profile: PlayerProfile) {
    profile.id = BigInt(id);
    // Inside a caller's transaction the commit is not known yet: only invalidate.
    const joined = this.db.isTransaction;
    atomic(this.db, () => {
      this.documents.put(id, 'profile.bin', toBinary(PlayerProfileSchema, profile));
      this.accounts.updateName(id, profile.firstName, profile.lastName);
    });
    this.invalidate(id);

    if (!joined) {
      this.cache.set(id, clone(PlayerProfileSchema, profile));
    }
  }

  /** Call after any change to the stored profile or account names outside save(). */
  invalidate(id: number) {
    this.versions.set(id, this.version(id) + 1);
    this.cache.delete(id);
  }
}
