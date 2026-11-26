import {
  blobRiderFigures,
  buildRange,
  isPlaceholderBuild,
  rankStrength,
  sizedBodyType,
  specialtyOf,
  STAND_RATIO,
} from '#src/world/pro-build';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const SIZE_MASK = 0x18_00;

await test('a known specialty is taken as given; an unknown one is guessed from the build', () => {
  assert.equal(specialtyOf('sprinter', 64, 1760), 'sprinter');
  assert.equal(specialtyOf('nonsense', 55, 1760), 'climber');
  assert.equal(specialtyOf(undefined, 85, 1800), 'sprinter');
});

await test('better-ranked riders are stronger, and riders without a rank ride at your level', () => {
  assert.equal(rankStrength(0), 1.15);
  assert.ok(rankStrength(5) > rankStrength(30));
  assert.ok(rankStrength(30) > rankStrength(150));
  assert.ok(rankStrength(150) > rankStrength(400));
  assert.equal(rankStrength(Infinity), 1);
});

await test('climbers are lighter than sprinters, and women lighter than men', () => {
  assert.ok(buildRange('climber', true).weight[1] < buildRange('sprinter', true).weight[0]);
  assert.ok(buildRange('gc', false).weight[1] < buildRange('gc', true).weight[0]);
});

await test('the default 64 kg / 176 cm entry is a placeholder, real data is not', () => {
  assert.equal(isPlaceholderBuild(64_000, 1760), true);
  assert.equal(isPlaceholderBuild(58_000, 1760), false);
});

await test('the avatar size follows the BMI and keeps the face and skin bits', () => {
  // Ciccone, 58 kg at 176 cm, drawn with the large male body: he must become small.
  assert.equal(sizedBodyType(6194, 58, 1760, true), (6194 & ~SIZE_MASK) | 0x8_00);
  assert.equal(sizedBodyType(2130, 75, 1800, true), (2130 & ~SIZE_MASK) | 0x10_00);
  assert.equal(sizedBodyType(2130, 100, 1800, true), (2130 & ~SIZE_MASK) | 0x18_00);
  // Women have only two sizes.
  assert.equal(sizedBodyType(2131, 90, 1700, false), (2131 & ~SIZE_MASK) | 0x10_00);
});

await test('a blob rider rides at your W/kg times its strength and stands at its specialty multiple of your FTP', () => {
  const owner = { ftp: 250, weightKg: 75 };

  for (const specialty of ['sprinter', 'gc', 'climber'] as const) {
    const rider = { weightKg: 66, rank: 0, specialty };
    const figures = blobRiderFigures(owner, rider);

    assert.ok(Math.abs(figures.powerScale - (1.15 * 66) / 75) < 1e-9);
    // Zwift stands an avatar above twice its FTP; the bot rides at powerScale times your power.
    const standsAtYourPower = (2 * figures.ftp) / figures.powerScale;
    assert.ok(Math.abs(standsAtYourPower / owner.ftp - STAND_RATIO[specialty]) < 0.01);
  }
});

await test('without your weight the figures fall back to a 75 kg rider', () => {
  const figures = blobRiderFigures({ ftp: 300, weightKg: 0 }, { weightKg: 75, rank: 500, specialty: 'rouleur' });

  assert.ok(Math.abs(figures.powerScale - 1) < 1e-9);
  assert.ok(figures.ftp > 300);
});
