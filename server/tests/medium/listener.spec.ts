import { packageRoot } from '#src/config/load';
import { startHttp } from '#src/node/network/http';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';

// These integration tests intentionally bind loopback ephemeral ports only.
await test('Node adapter serves HTTPS, binary bodies, forms, and actual peer addresses', async (t) => {
  const app = new Hono();
  app.get('/peer', (c) => c.text(getConnInfo(c).remote.address ?? ''));
  app.post('/binary', async (c) => c.body(new Uint8Array(await c.req.arrayBuffer())));
  app.post('/form', async (c) => c.json(await c.req.parseBody()));
  const root = resolve(packageRoot(), '../assets');

  const server = startHttp(app, {
    host: '127.0.0.1',
    port: 0,
    tls: {
      cert: readFileSync(resolve(root, 'ssl/cert-zwift-com.pem')),
      key: readFileSync(resolve(root, 'ssl/key-zwift-com.pem')),
    },
  });

  t.after(() => new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done()))));

  if (!server.listening) await once(server, 'listening');
  const { port } = z.object({ port: z.number() }).parse(server.address());

  const send = (path: string, body?: Uint8Array, contentType = 'application/octet-stream') =>
    new Promise<Buffer>((done, fail) => {
      const response = request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: body ? 'POST' : 'GET',
          rejectUnauthorized: false,
          headers: {
            'Content-Type': contentType,
            'X-Forwarded-For': '198.51.100.1',
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });
          incoming.on('end', () => done(Buffer.concat(chunks)));
          incoming.on('error', fail);
        },
      );

      response.on('error', fail);
      response.end(body);
    });

  const response1 = await send('/peer');
  assert.equal(response1.toString(), '127.0.0.1');
  const binary = Buffer.from([0, 255, 2, 0]);
  assert.deepEqual(await send('/binary', binary), binary);

  const form = Buffer.from('--test\r\nContent-Disposition: form-data; name="name"\r\n\r\nRider\r\n--test--\r\n');

  const response2 = await send('/form', form, 'multipart/form-data; boundary=test');
  assert.deepEqual(JSON.parse(response2.toString()), { name: 'Rider' });
});
