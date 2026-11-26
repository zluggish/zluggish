import { t } from '#src/i18n/index';
import { RuntimeContext } from '#src/context';
import { filenameSchema, manifestSchema } from '#src/dtos/profile-import.dto';

import type { ImportFile, ImportFiles, ImportManifest } from '#src/dtos/profile-import.dto';

import { EconomyConfigSchema } from '#src/protocol/generated/login_pb';
import { AchievementsSchema, PlayerProfileSchema, StreaksSchema } from '#src/protocol/generated/profile_pb';
import { UserStorageSchema } from '#src/protocol/generated/user_storage_pb';
import type { User } from '#src/repositories/accounts.repository';
import { immediate } from '#src/db/transaction';
import { clearField, fromBinary, fromJsonString, toBinary } from '@bufbuild/protobuf';
import { resolve } from 'node:path';
import { Context, Effect, Layer, Schema } from 'effect';

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const repositories = context.accounts.repositories;
  const { accounts, world } = context;

  const stageFolder = Effect.fn('ImportsService.folder')(function* (rider: User, stage: string) {
    if (!/^\.ts-import-[a-f0-9]{32}$/.test(stage)) {
      throw new Error(t('invalid_import_id'));
    }

    return resolve(accounts.storage, String(rider.player_id), stage);
  });

  const prepare = Effect.fn('ImportsService.prepare')(function* (rider: User, files: ImportFiles) {
    if (!accounts.identity(accounts.identityOf(rider))) {
      throw new Error(t('import_identity_changed'));
    }

    if (world.active(rider.player_id)) {
      throw new Error(t('profile_import_active_ride_blocked'));
    }
    let profile = null;
    const names: Array<ImportFile> = [];

    for (const name of Object.values(filenameSchema.enums)) {
      const key = Schema.decodeUnknownSync(filenameSchema)(name);
      const bytes = files[key];

      if (!bytes) {
        continue;
      }

      if (bytes.length > 16 * 1024 * 1024) {
        throw new Error(t('invalid_import_size'));
      }

      switch (key) {
        case 'profile.bin': {
          profile = fromBinary(PlayerProfileSchema, bytes);

          if (!profile.id || !profile.firstName.trim()) {
            throw new Error(t('profile_import_profile_identity_missing'));
          }

          break;
        }

        case 'achievements.bin': {
          toBinary(AchievementsSchema, fromBinary(AchievementsSchema, bytes));

          break;
        }

        case 'user_storage.bin': {
          toBinary(UserStorageSchema, fromBinary(UserStorageSchema, bytes));

          break;
        }

        case 'streaks.bin': {
          toBinary(StreaksSchema, fromBinary(StreaksSchema, bytes));

          break;
        }

        default: {
          if (
            Object.keys(
              Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
                JSON.parse(Buffer.from(bytes).toString()),
              ),
            ).length === 0
          ) {
            throw new Error(t('economy_config_empty'));
          }

          toBinary(EconomyConfigSchema, fromJsonString(EconomyConfigSchema, Buffer.from(bytes).toString()));
        }
      }

      names.push(key);
    }

    if (names.length === 0) {
      throw new Error(t('profile_import_category_required'));
    }
    const stage = `.ts-import-${repositories.cryptoRepository.randomBytes(16).toString('hex')}`;
    const folder = yield* stageFolder(rider, stage);
    repositories.filesRepository.mkdirSync(folder, { mode: 0o700 });

    const manifest: ImportManifest = {
      playerId: rider.player_id,
      authVersion: rider.auth_version,
      sourceId: profile?.id.toString() ?? null,
      firstName: profile?.firstName ?? '',
      lastName: profile?.lastName ?? '',
      files: names,
      before: {
        firstName: rider.first_name,
        lastName: rider.last_name,
        officialPlayerId: rider.official_player_id,
      },
      state: 'staged',
    };

    try {
      for (const name of names) {
        const bytes = files[name];

        if (bytes) {
          repositories.filesRepository.writeDurable(resolve(folder, name), bytes);
        }
      }

      repositories.filesRepository.writeDurable(resolve(folder, 'manifest.json'), JSON.stringify(manifest));
    } catch (error) {
      repositories.filesRepository.rmSync(folder, { recursive: true, force: true });
      throw error;
    }

    return stage;
  });

  const inspect = Effect.fn('ImportsService.inspect')(function* (rider: User, stage: string) {
    const manifest = Schema.decodeUnknownSync(manifestSchema)(
      JSON.parse(
        repositories.filesRepository.readFileSync(resolve(yield* stageFolder(rider, stage), 'manifest.json'), 'utf8'),
      ),
    );

    if (
      manifest.playerId !== rider.player_id ||
      manifest.authVersion !== rider.auth_version ||
      manifest.state !== 'staged'
    ) {
      throw new Error(t('profile_import_import_conflict'));
    }

    return manifest;
  });

  /** One transaction replaces the rider documents and account names and records the
  stage, so a repeated publication after a crash changes nothing. Replaced documents
  are kept as .bak files in the rider folder.
  */
  const publish = Effect.fn('ImportsService.publish')(function* (rider: User, stage: string, keepName: boolean) {
    if (world.active(rider.player_id)) {
      throw new Error(t('profile_import_active_ride_blocked'));
    }

    if (!accounts.identity(`${rider.player_id}:${rider.auth_version}`)) {
      throw new Error(t('import_identity_changed'));
    }
    const folder = yield* stageFolder(rider, stage);
    const manifest = yield* inspect(rider, stage);
    const target = resolve(accounts.storage, String(rider.player_id));
    const documents = new Map<ImportFile, Uint8Array>();

    for (const name of manifest.files) {
      let bytes: Uint8Array = repositories.filesRepository.readFileSync(resolve(folder, name));

      if (name === 'profile.bin') {
        const profile = fromBinary(PlayerProfileSchema, bytes);
        profile.id = BigInt(rider.player_id);

        if (profile.socialFacts) {
          profile.socialFacts.profileId = BigInt(rider.player_id);
        }
        clearField(profile, PlayerProfileSchema.field.publicId);
        profile.mixPanelDistinctId = repositories.cryptoRepository.randomUUID();

        if (keepName) {
          profile.firstName = rider.first_name;
          profile.lastName = rider.last_name;
        }

        bytes = toBinary(PlayerProfileSchema, profile);
      }

      documents.set(name, bytes);
    }

    for (const name of manifest.files) {
      const current = repositories.riderDocuments.get(rider.player_id, name);

      if (current) {
        repositories.filesRepository.writeDurable(resolve(target, `${name}.${stage.slice(11)}.bak`), current, true);
      }
    }

    immediate(accounts.db, () => {
      if (repositories.riderDocuments.imported(stage)) {
        return;
      }

      for (const [name, bytes] of documents) {
        repositories.riderDocuments.put(rider.player_id, name, bytes);
      }

      accounts.repository.updateImportedProfile(
        rider.player_id,
        manifest.files.includes('profile.bin') && !keepName ? manifest.firstName : rider.first_name,
        manifest.files.includes('profile.bin') && !keepName ? manifest.lastName : rider.last_name,
        manifest.sourceId ? BigInt(manifest.sourceId) : rider.official_player_id,
      );
      repositories.riderDocuments.recordImport(stage, rider.player_id);
    });

    repositories.profileRepository.invalidate(rider.player_id);
    repositories.filesRepository.rmSync(folder, { recursive: true });
  });

  const cancel = Effect.fn('ImportsService.cancel')(function* (rider: User, stage: string) {
    yield* inspect(rider, stage);
    repositories.filesRepository.rmSync(yield* stageFolder(rider, stage), { recursive: true });
  });

  /** Remove stages that were published or abandoned before a crash. A staged import
  waits for review; a published stage is never applied twice.
  */
  const recover = Effect.fn('ImportsService.recover')(function* () {
    for (const name of repositories.filesRepository.readdirSync(accounts.storage)) {
      if (!/^\d+$/.test(name)) {
        continue;
      }
      const riderFolder = resolve(accounts.storage, name);

      for (const entry of repositories.filesRepository.readdirSync(riderFolder, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }

        if (entry.name.startsWith('.import-')) {
          throw new Error(t('profile_import_legacy_recovery_required'));
        }

        if (!/^\.ts-import-[a-f0-9]{32}$/.test(entry.name)) {
          continue;
        }
        const folder = resolve(riderFolder, entry.name);

        // No manifest can exist before preparation finishes.
        if (!repositories.filesRepository.existsSync(resolve(folder, 'manifest.json'))) {
          repositories.filesRepository.rmSync(folder, { recursive: true });
          continue;
        }

        const manifest = Schema.decodeUnknownSync(manifestSchema)(
          JSON.parse(repositories.filesRepository.readFileSync(resolve(folder, 'manifest.json'), 'utf8')),
        );

        if (String(manifest.playerId) !== name) {
          throw new Error(t('import_journal_rider_mismatch'));
        }

        if (manifest.state !== 'staged' || repositories.riderDocuments.imported(entry.name)) {
          repositories.filesRepository.rmSync(folder, { recursive: true });
        }
      }
    }
  });

  return { folder: stageFolder, prepare, inspect, publish, cancel, recover };
});

export class ImportsService extends Context.Service<ImportsService, Effect.Success<typeof make>>()(
  'zluggish/ImportsService',
) {
  static readonly layer = Layer.effect(ImportsService, make);
}
