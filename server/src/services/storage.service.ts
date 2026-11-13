import type { RepositoryContext } from '#src/context';
import { ApplicationError } from '#src/errors';
import type { Achievements } from '#src/protocol/generated/profile_pb';
import { AchievementsSchema } from '#src/protocol/generated/profile_pb';
import type { UserStorage } from '#src/protocol/generated/user_storage_pb';
import { AttributesSchema, UserStorageSchema } from '#src/protocol/generated/user_storage_pb';
import { AchievementService } from '#src/services/achievement.service';
import { BaseService } from '#src/services/base.service';
import { create, isFieldSet } from '@bufbuild/protobuf';
import { reflect } from '@bufbuild/protobuf/reflect';
import { resolve } from 'node:path';
import { z } from 'zod';

const fileRow = z.object({
  id: z.number(),
  player_id: z.number(),
  folder: z.string(),
  filename: z.string(),
  timestamp: z.number(),
});

function safeName(value: string) {
  if (!value || value === '.' || value === '..' || /[\\/\0]/.test(value)) throw new ApplicationError(400);

  return value;
}

export class StorageService extends BaseService {
  constructor(private readonly context: RepositoryContext) {
    super(context.accounts.repositories);
  }

  achievements(id: number) {
    return new AchievementService(this.repositories).loadAchievements(this.context, id);
  }
  unlock(id: number, incoming: Achievements) {
    const file = resolve(this.context.profiles.folder(id), 'achievements.bin');
    const achievements = this.filesRepository.readData(AchievementsSchema, file);

    for (const achievement of incoming.achievements)
      if (achievements.achievements.every((item) => item.id !== achievement.id))
        achievements.achievements.push(achievement);
    this.filesRepository.saveData(AchievementsSchema, file, achievements);
  }
  attributes(id: number, requested: Set<number>) {
    const storage = this.filesRepository.readData(
      UserStorageSchema,
      resolve(this.context.profiles.folder(id), 'user_storage.bin'),
    );

    return create(UserStorageSchema, {
      attributes: storage.attributes.filter((attribute) =>
        AttributesSchema.fields.some((field) => requested.has(field.number) && isFieldSet(attribute, field)),
      ),
    });
  }
  saveAttributes(id: number, incoming: UserStorage) {
    const file = resolve(this.context.profiles.folder(id), 'user_storage.bin');
    const storage = this.filesRepository.readData(UserStorageSchema, file);

    for (const attribute of incoming.attributes) {
      const incomingFields = reflect(AttributesSchema, attribute);

      storage.attributes = storage.attributes.filter((old) => {
        const existing = reflect(AttributesSchema, old);

        for (const field of AttributesSchema.fields) {
          if (field.fieldKind !== 'message' || !incomingFields.isSet(field) || !existing.isSet(field)) continue;
          const signature = field.message.fields.find((nested) => nested.name === 'signature');

          if (!signature || existing.get(field).get(signature) === incomingFields.get(field).get(signature))
            existing.clear(field);
        }

        return AttributesSchema.fields.some((field) => existing.isSet(field)) || !!existing.getUnknown()?.length;
      });
      storage.attributes.push(attribute);
    }

    this.filesRepository.saveData(UserStorageSchema, file, storage);
  }
  upload(id: number, upload: { folder: string; filename: string; file: Uint8Array }) {
    const folder = safeName(upload.folder);

    if (folder.startsWith('.')) throw new ApplicationError(400);
    const name = safeName(upload.filename);
    this.filesRepository.write(resolve(this.context.profiles.folder(id), folder, name), upload.file);
    const existing = this.storageRepository.findZfile(id, folder, name);
    const timestamp = Math.floor(Date.now() / 1000);

    if (existing) this.storageRepository.updateZfileTimestamp(timestamp, fileRow.parse(existing).id);

    const fileId = existing
      ? fileRow.parse(existing).id
      : Number(this.storageRepository.insertZfile(id, folder, name, timestamp).lastInsertRowid);

    return { id: fileId, folder, name, timestamp };
  }
  list(id: number, folder: string) {
    return this.storageRepository.listZfile(id, folder).map((row) => fileRow.parse(row));
  }
  private owned(id: number, fileId: string) {
    const parsed = fileRow.safeParse(this.storageRepository.findZfileRow(fileId, id));

    if (!parsed.success) throw new ApplicationError(404);

    return parsed.data;
  }
  delete(id: number, fileId: string) {
    const row = this.owned(id, fileId);
    this.filesRepository.remove(
      resolve(this.context.profiles.folder(id), safeName(row.folder), safeName(row.filename)),
    );
    this.storageRepository.deleteZfile(row.id);
  }
  download(id: number, fileId: string) {
    const row = this.owned(id, fileId);

    const contents = this.filesRepository.read(
      resolve(this.context.profiles.folder(id), safeName(row.folder), safeName(row.filename)),
    );

    if (!contents) throw new ApplicationError(404);

    return contents;
  }
}
