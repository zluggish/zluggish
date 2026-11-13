import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import type { RequestOptions } from 'node:https';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { fetchCdn } from '#src/node/network/proxy';

class UpstreamRequest extends EventEmitter {
  setTimeout() {
    return this;
  }
  end() {}
}

function upstream(t: TestContext, status = 200) {
  const response = new IncomingMessage(new Socket());
  response.statusCode = status;
  response.headers = {
    'content-type': 'application/octet-stream',
    'transfer-encoding': 'chunked',
    connection: 'keep-alive',
  };
  const req = new UpstreamRequest();
  t.mock.method(
    https,
    'request',
    (url: string, _options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      assert.equal(url, 'https://cdn.zwift.com/gameassets/Game.xml');
      queueMicrotask(() => callback(response));

      return req;
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    response.destroy();
  });

  return { response, req };
}

await test('CDN proxy streams binary chunks and removes hop-by-hop headers', async (t) => {
  const { response } = upstream(t);
  const result = await fetchCdn('/gameassets/Game.xml');
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(result.headers.has('Connection'), false);
  assert.equal(result.headers.has('Transfer-Encoding'), false);
  const reading = result.arrayBuffer();
  response.push(Buffer.from([0, 255]));
  response.push(Buffer.from([1, 2]));
  response.push(null);
  assert.deepEqual(new Uint8Array(await reading), new Uint8Array([0, 255, 1, 2]));
});

await test('CDN proxy cancels upstream reading when its response is cancelled', async (t) => {
  const { response } = upstream(t);
  const result = await fetchCdn('/gameassets/Game.xml');
  await result.body?.cancel();
  assert.equal(response.destroyed, true);
});

await test('CDN proxy propagates upstream stream and connection failures', async (t) => {
  const { response, req } = upstream(t);
  const result = await fetchCdn('/gameassets/Game.xml');
  const reading = result.arrayBuffer();
  response.destroy(new Error('stream failed'));
  await assert.rejects(reading, /stream failed/);
  const connecting = fetchCdn('/gameassets/Game.xml');
  req.emit('error', new Error('connection failed'));
  await assert.rejects(connecting, /connection failed/);
});

await test('CDN proxy preserves a bodyless upstream response', async (t) => {
  const { response } = upstream(t, 304);
  const result = await fetchCdn('/gameassets/Game.xml');
  response.push(null);
  assert.equal(result.status, 304);
  assert.equal(result.body, null);
});
