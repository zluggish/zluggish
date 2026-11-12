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
