import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { fetchCdn } from '#src/node/network/proxy';

await test('CDN proxy uses the HTTPS transport for upstream requests', async (t) => {
  const sentinel = new Error('upstream request reached');
  const request = t.mock.method(https, 'request', (url: string) => {
    assert.equal(url, 'https://cdn.zwift.com/gameassets/Game.xml');
    throw sentinel;
  });
  syncBuiltinESMExports();
  t.after(() => {
    request.mock.restore();
    syncBuiltinESMExports();
  });

  await assert.rejects(fetchCdn('/gameassets/Game.xml'), (error) => error === sentinel);
  assert.equal(request.mock.callCount(), 1);
});
