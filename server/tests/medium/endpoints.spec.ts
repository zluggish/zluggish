import { mediumFixture } from '#tests/medium/support';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('invalid bearer credentials are rejected on public and protected endpoints', async (t) => {
  const f = await mediumFixture(t);

  for (const [path, anonymousStatus] of [
    ['/api/clubs/club/can-create', 200],
    ['/api/profiles/me', 401],
  ] as const) {
    const anonymous = await f.app.request(path);
    const authenticated = await f.request(path);
    const invalid = await f.app.request(path, { headers: { Authorization: 'Bearer invalid' } });

    assert.equal(anonymous.status, anonymousStatus);
    assert.equal(authenticated.status, 200);
    assert.equal(invalid.status, 401);
  }
});
