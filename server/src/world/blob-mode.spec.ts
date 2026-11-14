import { BlobBehavior } from '#src/world/blob-mode';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('new group modes replace old deadlines and expire strictly after the deadline', () => {
  const behavior = new BlobBehavior();
  assert.equal(behavior.mode, null);
  assert.equal(behavior.expire(100), false);

  for (const mode of ['attack', 'hammer', 'toast', 'lead'] as const) {
    behavior.enter(mode, 10);
    assert.equal(behavior.expire(10), false);
    assert.equal(behavior.mode, mode);
    assert.equal(behavior.expire(10.01), true);
    assert.equal(behavior.mode, null);
  }

  behavior.enter('attack', 10);
  behavior.enter('lead', 30);
  assert.equal(behavior.expire(11), false);
  assert.equal(behavior.mode, 'lead');
  behavior.enter(null, 99);
  assert.equal(behavior.expire(100), false);
});
