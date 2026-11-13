import { parseProtobuf } from '#src/http/protobuf';
import { authenticated } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import { AchievementsSchema } from '#src/protocol/generated/profile_pb';
import { UserStorageSchema } from '#src/protocol/generated/user_storage_pb';
import { ZFileProtoSchema, ZFilesProtoSchema } from '#src/protocol/generated/zfiles_pb';
import { create, toBinary } from '@bufbuild/protobuf';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

export function storageRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const service = runtime.services.storage;

  app.get('/api/achievement/loadPlayerAchievements', (c) => {
    const user = authenticated(c);

    return c.body(toBinary(AchievementsSchema, service.achievements(user.player_id)));
  });
  app.post('/api/achievement/unlock', async (c) => {
    const user = authenticated(c);

    service.unlock(user.player_id, parseProtobuf(AchievementsSchema, new Uint8Array(await c.req.arrayBuffer())));

    return c.body(null, 202);
  });
  app.on(['GET', 'POST'], '/api/player-profile/user-game-storage/attributes', async (c) => {
    const user = authenticated(c);

    if (c.req.method === 'POST') {
      service.saveAttributes(
        user.player_id,
        parseProtobuf(UserStorageSchema, new Uint8Array(await c.req.arrayBuffer())),
      );

      return c.body(null, 202);
    }

    const response = service.attributes(user.player_id, new Set((c.req.queries('n') ?? []).map(Number)));

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

    const { id, folder, name, timestamp } = service.upload(user.player_id, upload);

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

    const rows = service.list(user.player_id, c.req.query('folder') ?? '');

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

    if (c.req.method === 'DELETE') {
      service.delete(user.player_id, c.req.param('id'));

      return c.body(null, 200);
    }

    return c.body(service.download(user.player_id, c.req.param('id')));
  });
}
