import { CryptoRepository } from '#src/repositories/crypto.repository';
import { pythonFixtures as fixtures } from '#tests/support/python';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('Argon2id passwords verify and reject legacy hashes', async () => {
  const hash = await new CryptoRepository().hashPassword(fixtures.password);
  assert.ok(hash.startsWith('$argon2id$'));
  assert.notEqual(hash, await new CryptoRepository().hashPassword(fixtures.password));
  assert.equal(await new CryptoRepository().verifyPassword(hash, fixtures.password), true);
  assert.equal(await new CryptoRepository().verifyPassword(hash, 'wrong'), false);
  assert.equal(await new CryptoRepository().verifyPassword(hash, ''), false);
  assert.equal(await new CryptoRepository().verifyPassword('$argon2id$invalid', fixtures.password), false);
  assert.equal(await new CryptoRepository().verifyPassword(fixtures.scryptHash, fixtures.password), false);
  assert.equal(await new CryptoRepository().verifyPassword(fixtures.sha256Hash, fixtures.password), false);
  assert.equal(await new CryptoRepository().verifyPassword(fixtures.scryptHash, 'wrong'), false);
  assert.equal(await new CryptoRepository().verifyPassword(null, fixtures.password), false);
});

await test('passwords retain Unicode and differences beyond 72 bytes', async () => {
  const password = '🚴'.repeat(30);
  const hash = await new CryptoRepository().hashPassword(password);
  assert.equal(await new CryptoRepository().verifyPassword(hash, password), true);
  assert.equal(await new CryptoRepository().verifyPassword(hash, `${password}different`), false);
});

await test('Flask-Login signed identities remain interoperable', () => {
  const secret = Buffer.from(fixtures.secret, 'hex');
  assert.equal(new CryptoRepository().signIdentity(fixtures.identity, secret), fixtures.cookie);
  assert.equal(new CryptoRepository().verifyIdentity(fixtures.cookie, secret), fixtures.identity);
  assert.equal(new CryptoRepository().verifyIdentity(fixtures.cookie.replace('42:7', '43:7'), secret), null);
});
