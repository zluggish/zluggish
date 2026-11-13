import { filenameSchema, manifestSchema } from '#src/dtos/profile-import.dto';

import type { ImportFile, ImportFiles, ImportManifest } from '#src/dtos/profile-import.dto';

import { EconomyConfigSchema } from '#src/protocol/generated/login_pb';
import { AchievementsSchema, PlayerProfileSchema, StreaksSchema } from '#src/protocol/generated/profile_pb';
import { UserStorageSchema } from '#src/protocol/generated/user_storage_pb';
import type { Rider } from '#src/repositories/accounts.repository';
import type { AccountsService } from '#src/services/auth.service';
import { BaseService } from '#src/services/base.service';
import type { World } from '#src/world/state';
import { clearField, fromBinary, fromJsonString, toBinary } from '@bufbuild/protobuf';
import { resolve } from 'node:path';
import { z } from 'zod';

export class ImportsService extends BaseService {
  constructor(
    readonly accounts: AccountsService,
    readonly world: World,
  ) {
    super(accounts.repositories);
  }

  folder(rider: Rider, stage: string) {
    if (!/^\.ts-import-[a-f0-9]{32}$/.test(stage)) throw new Error('Invalid import ID');

    return resolve(this.accounts.storage, String(rider.player_id), stage);
  }

  prepare(rider: Rider, files: ImportFiles) {
    if (this.world.active(rider.player_id)) throw new Error('Finish the active ride before importing');
    let profile = null;
    const names: ImportFile[] = [];

    for (const name of filenameSchema.options) {
      const key = filenameSchema.parse(name);
      const bytes = files[key];

      if (!bytes) continue;

      if (bytes.length > 16 * 1024 * 1024) throw new Error('Invalid import size');

      switch (key) {
        case 'profile.bin': {
          profile = fromBinary(PlayerProfileSchema, bytes);

          if (!profile.id || !profile.firstName.trim()) throw new Error('Profile is missing its ID or name');

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
            Object.keys(z.record(z.string(), z.json()).parse(JSON.parse(Buffer.from(bytes).toString()))).length === 0
          ) {
            throw new Error('Economy configuration is empty');
          }

          toBinary(EconomyConfigSchema, fromJsonString(EconomyConfigSchema, Buffer.from(bytes).toString()));
        }
      }

      names.push(key);
    }

    if (names.length === 0) throw new Error('Select at least one import category');
    const stage = `.ts-import-${this.cryptoRepository.randomBytes(16).toString('hex')}`;
    const folder = this.folder(rider, stage);
    this.filesRepository.mkdirSync(folder, { mode: 0o700 });

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

        if (bytes) this.filesRepository.writeDurable(resolve(folder, name), bytes);
      }

      this.filesRepository.writeDurable(resolve(folder, 'manifest.json'), JSON.stringify(manifest));
    } catch (error) {
      this.filesRepository.rmSync(folder, { recursive: true, force: true });
      throw error;
    }

    return stage;
  }

  inspect(rider: Rider, stage: string) {
    const manifest = manifestSchema.parse(
      JSON.parse(this.filesRepository.readFileSync(resolve(this.folder(rider, stage), 'manifest.json'), 'utf8')),
    );

    if (
      manifest.playerId !== rider.player_id ||
      manifest.authVersion !== rider.auth_version ||
      manifest.state !== 'staged'
    )
      throw new Error('Import identity changed or import already finalized');

    return manifest;
  }

  publish(rider: Rider, stage: string, keepName: boolean) {
    if (this.world.active(rider.player_id)) throw new Error('Finish the active ride before importing');

    if (!this.accounts.identity(`${rider.player_id}:${rider.auth_version}`)) throw new Error('Import identity changed');
    const folder = this.folder(rider, stage);
    const manifest = this.inspect(rider, stage);
    const target = resolve(this.accounts.storage, String(rider.player_id));

    if (manifest.files.includes('profile.bin')) {
      const profile = fromBinary(
        PlayerProfileSchema,
        this.filesRepository.readFileSync(resolve(folder, 'profile.bin')),
      );

      profile.id = BigInt(rider.player_id);

      if (profile.socialFacts) profile.socialFacts.profileId = BigInt(rider.player_id);
      clearField(profile, PlayerProfileSchema.field.publicId);
      profile.mixPanelDistinctId = this.cryptoRepository.randomUUID();

      if (keepName) {
        profile.firstName = rider.first_name;
        profile.lastName = rider.last_name;
      }

      this.filesRepository.writeDurable(resolve(folder, 'profile.bin'), toBinary(PlayerProfileSchema, profile), true);
    }

    manifest.before = {
      firstName: rider.first_name,
      lastName: rider.last_name,
      officialPlayerId: rider.official_player_id,
    };

    for (const name of manifest.files) {
      const current = resolve(target, name);

      if (!this.filesRepository.existsSync(current)) {
        continue;
      }

      this.filesRepository.writeDurable(resolve(folder, `old-${name}`), this.filesRepository.readFileSync(current));
      this.filesRepository.writeDurable(
        resolve(target, `${name}.${stage.slice(11)}.bak`),
        this.filesRepository.readFileSync(current),
      );
    }

    manifest.state = 'publishing';
    this.filesRepository.writeDurable(resolve(folder, 'manifest.json'), JSON.stringify(manifest), true);

    try {
      for (const name of manifest.files)
        this.filesRepository.writeDurable(
          resolve(target, name),
          this.filesRepository.readFileSync(resolve(folder, name)),
          true,
        );

      this.accounts.repository.updateImportedProfile(
        rider.player_id,
        manifest.files.includes('profile.bin') && !keepName ? manifest.firstName : rider.first_name,
        manifest.files.includes('profile.bin') && !keepName ? manifest.lastName : rider.last_name,
        manifest.sourceId ? BigInt(manifest.sourceId) : rider.official_player_id,
      );
      manifest.state = 'committed';
      this.filesRepository.writeDurable(resolve(folder, 'manifest.json'), JSON.stringify(manifest), true);
    } catch (error) {
      this.rollback(folder, manifest);
      throw error;
    }

    this.filesRepository.rmSync(folder, { recursive: true });
  }

  cancel(rider: Rider, stage: string) {
    this.inspect(rider, stage);
    this.filesRepository.rmSync(this.folder(rider, stage), { recursive: true });
  }

  rollback(folder: string, manifest: ImportManifest) {
    const target = resolve(this.accounts.storage, String(manifest.playerId));

    for (const name of manifest.files) {
      const old = resolve(folder, `old-${name}`);
      const current = resolve(target, name);

      if (this.filesRepository.existsSync(old))
        this.filesRepository.writeDurable(current, this.filesRepository.readFileSync(old), true);
      else if (this.filesRepository.existsSync(current)) this.filesRepository.unlinkSync(current);
    }

    this.accounts.repository.updateImportedProfile(
      manifest.playerId,
      manifest.before.firstName,
      manifest.before.lastName,
      manifest.before.officialPlayerId,
    );
  }

  recover() {
    for (const name of this.filesRepository.readdirSync(this.accounts.storage)) {
      if (!/^\d+$/.test(name)) continue;
      const riderFolder = resolve(this.accounts.storage, name);

      for (const entry of this.filesRepository.readdirSync(riderFolder, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;

        if (entry.name.startsWith('.import-'))
          throw new Error('Recover the legacy profile import before starting TypeScript');

        if (!/^\.ts-import-[a-f0-9]{32}$/.test(entry.name)) continue;
        const folder = resolve(riderFolder, entry.name);

        // No manifest can exist before preparation finishes; publishing always has one.
        if (!this.filesRepository.existsSync(resolve(folder, 'manifest.json'))) {
          this.filesRepository.rmSync(folder, { recursive: true });
          continue;
        }

        const manifest = manifestSchema.parse(
          JSON.parse(this.filesRepository.readFileSync(resolve(folder, 'manifest.json'), 'utf8')),
        );

        if (String(manifest.playerId) !== name) throw new Error('Import journal rider mismatch');

        if (manifest.state === 'publishing') this.rollback(folder, manifest);

        if (manifest.state !== 'staged') this.filesRepository.rmSync(folder, { recursive: true });
      }
    }
  }
}
