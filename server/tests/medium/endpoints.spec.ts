import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mediumFixture } from '#tests/medium/support';

await test('invalid bearer credentials are rejected on public and protected endpoints', async (t) => {
  const f = await mediumFixture(t);

  for (const [path, anonymousStatus] of [
    ['/api/clubs/club/can-create', 200],
    ['/api/profiles/me', 401],
  ] as const) {
    assert.equal((await f.app.request(path)).status, anonymousStatus);
    assert.equal((await f.request(path)).status, 200);
    assert.equal(
      (await f.app.request(path, { headers: { Authorization: 'Bearer invalid' } })).status,
      401,
    );
  }
});
