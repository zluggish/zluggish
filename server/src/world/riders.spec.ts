import { packageRoot } from '#src/config/load';
import { RiderPool } from '#src/world/riders';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

await test('synthetic rider profiles make their weight public', () => {
  const pool = new RiderPool(resolve(packageRoot(), '../assets'), '');
  const profile = pool.profile(8_000_001n);

  assert.ok(profile.weightInGrams > 0);
  assert.equal(profile.privacyBits & 4n, 4n);
});

await test('a riders file keeps the body type and the facial hair it names, and the rest is drawn', () => {
  const file = resolve(mkdtempSync(resolve(tmpdir(), 'riders-')), 'riders.json');

  writeFileSync(
    file,
    JSON.stringify({
      riders: [
        { first_name: 'Named', is_male: true, body_type: 2066, facial_hair_type: 0 },
        { first_name: 'Drawn', is_male: true },
      ],
    }),
  );

  const pool = new RiderPool(resolve(packageRoot(), '../assets'), file);
  const named = pool.profile(8_000_002n);
  const drawn = pool.profile(8_000_003n);

  assert.equal(named.firstName, 'Named');
  assert.equal(named.bodyType, 2066);
  assert.equal(named.facialHairType, 0);

  assert.equal(drawn.firstName, 'Drawn');
  assert.ok(drawn.bodyType > 0);
});
