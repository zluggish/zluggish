import assert from 'node:assert/strict';
import { test } from 'node:test';

import { climbCategory, straightProfile } from '#src/world/climb-category';

await test('climbCategory returns null below the lowest threshold', () => {
  assert.equal(climbCategory(1000, 7.99), null);
});

await test('climbCategory returns 4 at exactly 8000', () => {
  assert.equal(climbCategory(1000, 8), '4');
});

await test('climbCategory returns 3 at exactly 16000', () => {
  assert.equal(climbCategory(2000, 8), '3');
});

await test('climbCategory returns 2 at exactly 32000', () => {
  assert.equal(climbCategory(4000, 8), '2');
});

await test('climbCategory returns 1 at exactly 64000', () => {
  assert.equal(climbCategory(8000, 8), '1');
});

await test('climbCategory returns HC at exactly 80000', () => {
  assert.equal(climbCategory(8000, 10), 'HC');
});

await test('climbCategory returns null for zero distance', () => {
  assert.equal(climbCategory(0, 10), null);
});

await test('straightProfile returns exactly two points from origin to summit', () => {
  assert.deepEqual(straightProfile(800, 57), [
    [0, 0],
    [800, 57],
  ]);
});
