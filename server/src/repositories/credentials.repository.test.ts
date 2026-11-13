import { decryptCredentials, encryptCredentials } from '#src/repositories/credentials.repository';
import { pythonFixtures as fixtures } from '#tests/support/python';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('credentials use Python CFB8 encoding, not CFB128', () => {
  const key = Buffer.from(fixtures.credentialKey, 'hex');
  const wire = Buffer.from(fixtures.credentials, 'hex');
  assert.deepEqual(decryptCredentials(key, wire), ['example-user', 'example-password']);
  assert.equal(
    encryptCredentials(key, ['example-user', 'example-password'], wire.subarray(0, 16)).toString('hex'),
    fixtures.credentials,
  );
});
