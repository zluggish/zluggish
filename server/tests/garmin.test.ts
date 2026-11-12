import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { garminClient, uploadGarmin } from '#src/node/integrations/garmin';
import { runtimeFixture } from '#tests/support/runtime';

await test('Garmin imports FIT using existing garth tokens entirely through Node', async (t) => {
  const f = runtimeFixture(t);
  const folder = resolve(f.config.storageDir, 'garth');
  mkdirSync(folder);
  writeFileSync(
    resolve(folder, 'oauth1_token.json'),
    JSON.stringify({
      oauth_token: 'synthetic',
      oauth_token_secret: 'synthetic-secret',
      domain: 'garmin.com',
    }),
  );
  writeFileSync(
    resolve(folder, 'oauth2_token.json'),
    JSON.stringify({
      scope: '',
      jti: '',
      token_type: 'Bearer',
      access_token: 'synthetic-access',
      refresh_token: 'synthetic-refresh',
      expires_in: 86_400,
      refresh_token_expires_in: 86_400,
      expires_at: Date.now() / 1000 + 86_400,
      refresh_token_expires_at: Date.now() / 1000 + 86_400,
    }),
  );
  let uploads = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://connectapi.garmin.com/upload-service/upload/fit');
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer synthetic-access');
    assert.ok(init?.body instanceof FormData);
    const file = init.body.get('file');
    assert.ok(file instanceof Blob);
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array([1, 2, 3]));
    uploads++;

    return Response.json({
      detailedImportResult: {
        successes: [{ internalId: 123 }],
        failures: [],
      },
    });
  });
  await uploadGarmin(folder, 'garmin.com', 'ride.fit', new Uint8Array([1, 2, 3]));
  assert.equal(uploads, 1);
  assert.throws(() => garminClient(folder, 'untrusted.example'), /Unsupported/);
});
