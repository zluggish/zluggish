import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PasswordLimits } from '#src/http/password-limits';

await test('password limits share account budgets across peers and expire without extending lockout', () => {
  let now = 0;
  const limits = new PasswordLimits(() => now);
  for (let i = 0; i < 10; i++) {
    const release = limits.acquire(`peer-${i}`, 1);
    assert.ok(release);
    release();
  }
  assert.equal(limits.acquire('another-peer', 1), null);
  now = 59_999;
  assert.equal(limits.acquire('another-peer', 1), null);
  now = 60_000;
  assert.ok(limits.acquire('another-peer', 1));
});

await test('peer budgets cover rotating and unknown accounts', () => {
  const limits = new PasswordLimits();
  for (let i = 0; i < 30; i++) {
    const release = limits.acquire('peer', i % 2 ? i : undefined);
    assert.ok(release);
    release();
  }
  assert.equal(limits.acquire('peer', 100), null);
  assert.ok(limits.acquire('other-peer', 100));
});

await test('hashing slots are bounded, per account, and released exactly once', () => {
  const limits = new PasswordLimits();
  const release = limits.acquire('peer', 1);
  assert.ok(release);
  assert.equal(limits.acquire('other-peer', 1), null);
  const others = [2, 3, 4].map((id) => limits.acquire(`peer-${id}`, id));
  assert.ok(others.every(Boolean));
  assert.equal(limits.acquire('peer-5', 5), null);
  release();
  release();
  const fifth = limits.acquire('peer-5', 5);
  assert.ok(fifth);
  assert.equal(limits.acquire('peer-6', 6), null);
  others[0]?.();
  assert.ok(limits.acquire('peer-6', 6));
});

await test('full tracking tables fail closed and expired entries free capacity', () => {
  let now = 0;
  const limits = new PasswordLimits(() => now);
  for (let i = 0; i < 4096; i++) {
    const release = limits.acquire(`peer-${i}`, i);
    assert.ok(release);
    release();
  }
  assert.equal(limits.acquire('new-peer', 5000), null);
  now = 60_000;
  assert.ok(limits.acquire('new-peer', 5000));
});
