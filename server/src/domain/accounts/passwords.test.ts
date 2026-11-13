import { signIdentity, verifyIdentity, verifyPassword } from '#src/domain/accounts/passwords';
import { pythonFixtures as fixtures } from '#tests/support/python';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('Werkzeug hashes and Flask-Login signed identities remain interoperable', async () => {
  assert.equal(await verifyPassword(fixtures.scryptHash, fixtures.password), true);
  assert.equal(await verifyPassword(fixtures.sha256Hash, fixtures.password), true);
  assert.equal(await verifyPassword(fixtures.scryptHash, 'wrong'), false);
  assert.equal(await verifyPassword(null, fixtures.password), false);
  const secret = Buffer.from(fixtures.secret, 'hex');
  assert.equal(signIdentity(fixtures.identity, secret), fixtures.cookie);
  assert.equal(verifyIdentity(fixtures.cookie, secret), fixtures.identity);
  assert.equal(verifyIdentity(fixtures.cookie.replace('42:7', '43:7'), secret), null);
});
