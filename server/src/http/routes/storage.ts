import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { create, fromBinary, toBinary, toJsonString, isFieldSet } from '@bufbuild/protobuf';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { AchievementsSchema } from '#src/protocol/generated/profile_pb';
import { UserStorageSchema, AttributesSchema } from '#src/protocol/generated/user_storage_pb';
import { ZFileProtoSchema, ZFilesProtoSchema } from '#src/protocol/generated/zfiles_pb';
import { authenticated } from '#src/http/routes/accounts';
import { writeDurable } from '#src/node/persistence/files';
import type { Runtime, RuntimeEnv } from '#src/http/runtime';

const fileRow = z.object({
  id: z.number(),
  player_id: z.number(),
  folder: z.string(),
  filename: z.string(),
  timestamp: z.number(),
});

function safeName(value: string) {
  if (!value || value === '.' || value === '..' || /[\\/\0]/.test(value)) throw new HTTPException(400);

  return value;
}

export function storageRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  app.get('/api/achievement/loadPlayerAchievements', (c) => {
    const user = authenticated(c);

    const file = resolve(runtime.profiles.folder(user.player_id), 'achievements.bin');

    return c.body(existsSync(file) ? readFileSync(file) : toBinary(AchievementsSchema, create(AchievementsSchema)));
  });
  app.post('/api/achievement/unlock', async (c) => {
    const user = authenticated(c);

    const file = resolve(runtime.profiles.folder(user.player_id), 'achievements.bin');

    const achievements = existsSync(file)
      ? fromBinary(AchievementsSchema, readFileSync(file))
      : create(AchievementsSchema);

    const incoming = fromBinary(AchievementsSchema, new Uint8Array(await c.req.arrayBuffer()));

    for (const achievement of incoming.achievements)
      if (achievements.achievements.every((item) => item.id !== achievement.id))
        achievements.achievements.push(achievement);

    writeDurable(file, toBinary(AchievementsSchema, achievements), true);

    return c.body(null, 202);
  });
  app.on(['GET', 'POST'], '/api/player-profile/user-game-storage/attributes', async (c) => {
    const user = authenticated(c);

    const file = resolve(runtime.profiles.folder(user.player_id), 'user_storage.bin');

    const storage = existsSync(file) ? fromBinary(UserStorageSchema, readFileSync(file)) : create(UserStorageSchema);

    if (c.req.method === 'POST') {
      const incoming = fromBinary(UserStorageSchema, new Uint8Array(await c.req.arrayBuffer()));

      const attributeSchema = UserStorageSchema.field.attributes.message;

      if (!attributeSchema) throw new Error('Missing user storage descriptor');

      for (const attribute of incoming.attributes) {
        const keys = attributeSchema.fields.filter((field) => isFieldSet(attribute, field));

        const incomingValues = z.record(z.string(), z.object({ signature: z.string().optional() }).passthrough()).parse(
          JSON.parse(
            toJsonString(AttributesSchema, attribute, {
              useProtoFieldName: true,
            }),
          ),
        );

        storage.attributes = storage.attributes.filter((old) => {
          const existingValues = z
            .record(z.string(), z.object({ signature: z.string().optional() }).passthrough())
            .parse(
              JSON.parse(
                toJsonString(AttributesSchema, old, {
                  useProtoFieldName: true,
                }),
              ),
            );

          return keys.every(
            (field) =>
              !(
                isFieldSet(old, field) &&
                (!field.message?.fields.some((nested) => nested.name === 'signature') ||
                  existingValues[field.name]?.signature === incomingValues[field.name]?.signature)
              ),
          );
        });
        storage.attributes.push(attribute);
      }

      writeDurable(file, toBinary(UserStorageSchema, storage), true);

      return c.body(null, 202);
    }

    const requested = new Set((c.req.queries('n') ?? []).map(Number));
    const attributeSchema = UserStorageSchema.field.attributes.message;

    if (!attributeSchema) throw new Error('Missing user storage descriptor');

    const response = create(UserStorageSchema, {
      attributes: storage.attributes.filter((attribute) =>
        attributeSchema.fields.some((field) => requested.has(field.number) && isFieldSet(attribute, field)),
      ),
    });

    return c.body(toBinary(UserStorageSchema, response));
  });
  app.post('/api/zfiles', async (c) => {
    const user = authenticated(c);

    const upload = fromBinary(ZFileProtoSchema, new Uint8Array(await c.req.arrayBuffer()));

    const folder = safeName(upload.folder);
    const name = safeName(upload.filename);
    writeDurable(resolve(runtime.profiles.folder(user.player_id), folder, name), upload.file, true);
    const db = runtime.accounts.db;

    const existing = db
      .prepare('SELECT * FROM zfile WHERE player_id=? AND folder=? AND filename=?')
      .get(user.player_id, folder, name);

    const timestamp = Math.floor(Date.now() / 1000);

    const id = existing
      ? fileRow.parse(existing).id
      : Number(
          db
            .prepare('INSERT INTO zfile (player_id,folder,filename,timestamp) VALUES (?,?,?,?)')
            .run(user.player_id, folder, name, timestamp).lastInsertRowid,
        );

    return c.body(
      toBinary(
        ZFileProtoSchema,
        create(ZFileProtoSchema, {
          id: BigInt(id),
          folder,
          filename: name,
          timestamp: BigInt(timestamp),
        }),
      ),
    );
  });
  app.get('/api/zfiles/list', (c) => {
    const user = authenticated(c);

    const rows = runtime.accounts.db
      .prepare('SELECT * FROM zfile WHERE player_id=? AND folder=?')
      .all(user.player_id, c.req.query('folder') ?? '')
      .map((row) => fileRow.parse(row));

    return c.body(
      toBinary(
        ZFilesProtoSchema,
        create(ZFilesProtoSchema, {
          zfiles: rows.map((row) => ({
            id: BigInt(row.id),
            folder: row.folder,
            filename: row.filename,
            timestamp: BigInt(row.timestamp),
          })),
        }),
      ),
    );
  });
  app.on(['GET', 'DELETE'], ['/api/zfiles/:id/download', '/api/zfiles/:id'], (c) => {
    const user = authenticated(c);

    const parsed = fileRow.safeParse(
      runtime.accounts.db
        .prepare('SELECT * FROM zfile WHERE id=? AND player_id=?')
        .get(c.req.param('id'), user.player_id),
    );

    if (!parsed.success) throw new HTTPException(404);
    const row = parsed.data;

    const file = resolve(runtime.profiles.folder(user.player_id), safeName(row.folder), safeName(row.filename));

    if (c.req.method === 'DELETE') {
      if (existsSync(file)) unlinkSync(file);

      runtime.accounts.db.prepare('DELETE FROM zfile WHERE id=?').run(row.id);

      return c.body(null, 200);
    }

    if (!existsSync(file)) throw new HTTPException(404);

    return c.body(readFileSync(file));
  });
}
