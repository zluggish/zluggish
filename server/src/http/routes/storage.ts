import { loadAchievements } from '#src/domain/profiles/achievements';
import { reflect } from '@bufbuild/protobuf/reflect';
import { parseProtobuf } from '#src/http/protobuf';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { create, fromBinary, toBinary, isFieldSet } from '@bufbuild/protobuf';
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

    return c.body(toBinary(AchievementsSchema, loadAchievements(runtime, user.player_id)));
  });
  app.post('/api/achievement/unlock', async (c) => {
    const user = authenticated(c);

    const file = resolve(runtime.profiles.folder(user.player_id), 'achievements.bin');

    const achievements = existsSync(file)
      ? fromBinary(AchievementsSchema, readFileSync(file))
      : create(AchievementsSchema);

    const incoming = parseProtobuf(AchievementsSchema, new Uint8Array(await c.req.arrayBuffer()));

    for (const achievement of incoming.achievements)
      if (achievements.achievements.every((item) => item.id !== achievement.id))
        achievements.achievements.push(achievement);

    writeDurable(file, toBinary(AchievementsSchema, achievements), true);

    return c.body(null, 202);
  });
  app.on(['GET', 'POST'], '/api/player-profile/user-game-storage/attributes', async (c) => {
    const user = authenticated(c);

    const file = resolve(runtime.profiles.folder(user.player_id), 'user_storage.bin');

    if (c.req.method === 'POST') {
      const incoming = parseProtobuf(UserStorageSchema, new Uint8Array(await c.req.arrayBuffer()));
      const storage = existsSync(file) ? fromBinary(UserStorageSchema, readFileSync(file)) : create(UserStorageSchema);

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

      writeDurable(file, toBinary(UserStorageSchema, storage), true);

      return c.body(null, 202);
    }

    const storage = existsSync(file) ? fromBinary(UserStorageSchema, readFileSync(file)) : create(UserStorageSchema);
    const requested = new Set((c.req.queries('n') ?? []).map(Number));

    const response = create(UserStorageSchema, {
      attributes: storage.attributes.filter((attribute) =>
        AttributesSchema.fields.some((field) => requested.has(field.number) && isFieldSet(attribute, field)),
      ),
    });

    return c.body(toBinary(UserStorageSchema, response));
  });
  app.post('/api/zfiles', async (c) => {
    const user = authenticated(c);

    let upload;

    if (c.req.header('Source') === 'zwift-companion') {
      const input = z
        .object({
          folder: z.string(),
          name: z.string(),
          content: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
        })
        .parse(
          await c.req.json().catch(() => {
            throw new HTTPException(400);
          }),
        );

      upload = { folder: input.folder, filename: input.name, file: Buffer.from(input.content, 'base64') };
    } else upload = parseProtobuf(ZFileProtoSchema, new Uint8Array(await c.req.arrayBuffer()));

    const folder = safeName(upload.folder);
    const name = safeName(upload.filename);
    writeDurable(resolve(runtime.profiles.folder(user.player_id), folder, name), upload.file, true);
    const db = runtime.accounts.db;

    const existing = db
      .prepare('SELECT * FROM zfile WHERE player_id=? AND folder=? AND filename=?')
      .get(user.player_id, folder, name);

    const timestamp = existing ? fileRow.parse(existing).timestamp : Math.floor(Date.now() / 1000);

    const id = existing
      ? fileRow.parse(existing).id
      : Number(
          db
            .prepare('INSERT INTO zfile (player_id,folder,filename,timestamp) VALUES (?,?,?,?)')
            .run(user.player_id, folder, name, timestamp).lastInsertRowid,
        );

    if (c.req.header('Accept')?.includes('application/json'))
      return c.json({
        id,
        folder,
        name,
        content: null,
        lastModified: new Date(timestamp * 1000).toISOString().replace('Z', '+0000'),
      });

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
