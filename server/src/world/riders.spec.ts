import { packageRoot } from '#src/config/load';
import { RiderPool } from '#src/world/riders';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

await test('synthetic rider profiles make their weight public', () => {
  const pool = new RiderPool(resolve(packageRoot(), '../assets'), '');
  const profile = pool.profile(8_000_001n);

  assert.ok(profile.weightInGrams > 0);
  assert.equal(profile.privacyBits & 4n, 4n);
});

await test('riders file entries carry their rank, specialty and a build that fits it', (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), 'riders-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = resolve(folder, 'riders.json');
  writeFileSync(
    file,
    JSON.stringify({
      riders: [
        // A ranked climber whose real build is known but whose body was drawn large.
        {
          first_name: 'Giulio',
          last_name: 'Climber',
          is_male: true,
          specialty: 'climber',
          rank: 17,
          body_type: 6194,
          weight_in_grams: 58_000,
          height_in_millimeters: 1760,
        },
        // An unranked sprinter with the placeholder build of the riders file.
        {
          first_name: 'Tim',
          last_name: 'Sprinter',
          is_male: true,
          specialty: 'sprinter',
          weight_in_grams: 64_000,
          height_in_millimeters: 1760,
        },
      ],
    }),
  );
  const pool = new RiderPool(resolve(packageRoot(), '../assets'), file);

  const climber = pool.profile(8_000_001n);
  assert.deepEqual(pool.traitsOf(climber.id), { rank: 17, specialty: 'climber' });
  assert.equal(climber.weightInGrams, 58_000);
  assert.equal(climber.bodyType, (6194 & ~0x18_00) | 0x8_00);

  const sprinter = pool.profile(8_000_002n);
  // Without a rank the place in the file counts: second among the men.
  assert.deepEqual(pool.traitsOf(sprinter.id), { rank: 1, specialty: 'sprinter' });
  assert.ok(sprinter.weightInGrams >= 70_000 && sprinter.weightInGrams <= 80_000);
});
