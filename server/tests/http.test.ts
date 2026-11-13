import { runtimeFixture } from '#tests/support/runtime';
import { writeDurable } from '#src/node/persistence/files';
import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { createApp } from '#src/http/app';
import { FeatureRequestSchema, FeatureResponseSchema } from '#src/protocol/generated/variants_pb';

const metadata = {
  gameInfo: '{"gameInfoHash":"abc"}',
  gameInfoHash: 'abc',
  variants: '{"variants":[{"name":"enabled","value":true}]}',
};

await test('public metadata routes preserve response values and content types', async () => {
  const app = createApp(metadata);
  const version = await app.request('/api/game_info/version');
  assert.deepEqual(await version.json(), { version: 'abc' });
  const info = await app.request('/api/game_info');
  assert.equal(info.headers.get('Content-Type'), 'application/json');
  assert.equal(await info.text(), metadata.gameInfo);
  const health = await app.request('/health');
  assert.deepEqual(await health.json(), {
    status: 'ok',
    implementation: 'typescript',
    rideReady: false,
  });
});

await test('machine variant endpoint consumes and returns protobuf, including unknown names', async () => {
  const request = toBinary(
    FeatureRequestSchema,
    create(FeatureRequestSchema, {
      params: [{ param: ['enabled', 'missing'] }],
    }),
  );

  const response = await createApp(metadata).request('/experimentation/v1/machine-id-variant', {
    method: 'POST',
    body: request,
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');

  const decoded = fromBinary(FeatureResponseSchema, new Uint8Array(await response.arrayBuffer()));

  assert.equal(decoded.variants[0]?.value, true);
  assert.equal(decoded.variants[1]?.name, 'missing');
});

await test('malformed binary input fails without a stack trace', async () => {
  const response = await createApp(metadata).request('/experimentation/v1/machine-id-variant', {
    method: 'POST',
    body: new Uint8Array([255]),
  });

  assert.equal(response.status, 400);
  assert.equal(await response.text(), 'Invalid request');
});

await test('malformed protobuf and missing required fields return 400 without changing stored data', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Invalid Input', '', true);
  const headers = { Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}` };

  for (const path of ['/api/segment-results', `/api/profiles/${user.player_id}/in-game-fields`, '/api/users/login']) {
    const response = await f.app.request(path, {
      method: path.includes('in-game-fields') ? 'PUT' : 'POST',
      headers,
      body: new Uint8Array([255]),
    });

    assert.equal(response.status, 400, path);
    assert.equal(await response.text(), 'Invalid request');
  }

  const missing = await f.app.request('/api/segment-results', { method: 'POST', headers, body: new Uint8Array() });
  assert.equal(missing.status, 400);
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS count FROM segment_result').get()?.count, 0);
  assert.equal(f.profiles.get(user.player_id).firstName, 'Invalid');
});

await test('unexpected failures are logged while responses omit error details', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Broken Profile', '', true);
  writeDurable(resolve(f.profiles.folder(user.player_id), 'profile.bin'), new Uint8Array([255]));
  const logged = t.mock.method(console, 'error', () => {});

  const response = await f.app.request('/api/profiles/me', {
    headers: { Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}` },
  });

  assert.equal(response.status, 500);
  assert.equal(await response.text(), 'Request failed');
  assert.equal(logged.mock.callCount(), 1);
  assert.equal(logged.mock.calls[0]?.arguments[0], 'Request failed: GET /api/profiles/me');
});
