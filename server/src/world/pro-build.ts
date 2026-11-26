/** The build and strength of a bot rider, from its specialty and its place in the rankings.

The game stands an avatar up to sprint above twice the FTP of its profile, and draws its body from the
body type. A blob rider rides at your W/kg scaled by its strength, so it feels like your ride; its FTP is
set so it stands up only when you go past a multiple of your own FTP that suits its specialty.
*/

export const SPECIALTIES = ['gc', 'climber', 'hills', 'oneday', 'sprinter', 'rouleur'] as const;

export type Specialty = (typeof SPECIALTIES)[number];

export interface ProTraits {
  /** Place among the riders of the same sex in the riders file, best first; infinite when unranked. */
  rank: number;
  specialty: Specialty;
}

/** Multiples of your FTP above which a blob rider of each specialty stands up to sprint. */
export const STAND_RATIO: Readonly<Record<Specialty, number>> = {
  sprinter: 2.5,
  oneday: 2.6,
  hills: 2.7,
  rouleur: 2.7,
  gc: 2.9,
  climber: 3,
};

type Range = readonly [number, number];

interface BuildRange {
  /** Kilograms. */
  weight: Range;
  /** Millimetres. */
  height: Range;
}

const MALE_BUILDS: Readonly<Record<Specialty, BuildRange>> = {
  climber: { weight: [56, 63], height: [1650, 1780] },
  gc: { weight: [60, 67], height: [1700, 1820] },
  hills: { weight: [62, 69], height: [1700, 1820] },
  oneday: { weight: [68, 76], height: [1780, 1900] },
  sprinter: { weight: [70, 80], height: [1750, 1860] },
  rouleur: { weight: [72, 84], height: [1820, 1950] },
};

const FEMALE_BUILDS: Readonly<Record<Specialty, BuildRange>> = {
  climber: { weight: [48, 54], height: [1580, 1680] },
  gc: { weight: [52, 58], height: [1630, 1720] },
  hills: { weight: [53, 59], height: [1620, 1720] },
  oneday: { weight: [58, 65], height: [1680, 1780] },
  sprinter: { weight: [60, 68], height: [1650, 1760] },
  rouleur: { weight: [62, 70], height: [1720, 1820] },
};

/** The riders file fills unknown riders with 64 kg at 176 cm. */
const PLACEHOLDER_WEIGHT_G = 64_000;
const PLACEHOLDER_HEIGHT_MM = 1760;

/** The body type bits that choose the avatar size; the others pick the face and skin. */
const SIZE_MASK = 0x18_00;
const SIZE_SMALL = 0x8_00;
const SIZE_MEDIUM = 0x10_00;
const SIZE_LARGE = 0x18_00;

/** Zwift's avatar sizes by BMI: men small below 21 and large above 26, women small below 22. */
const MALE_SMALL_BMI = 21;
const MALE_LARGE_BMI = 26;
const FEMALE_SMALL_BMI = 22;

const FALLBACK_OWNER_KG = 75;

export function isSpecialty(value: unknown): value is Specialty {
  return typeof value === 'string' && (SPECIALTIES as ReadonlyArray<string>).includes(value);
}

function bmi(weightKg: number, heightMm: number): number {
  const metres = heightMm / 1000;

  return metres > 0 ? weightKg / (metres * metres) : 0;
}

/** The specialty from the riders file, else a guess from the build. */
export function specialtyOf(value: unknown, weightKg: number, heightMm: number): Specialty {
  if (isSpecialty(value)) {
    return value;
  }
  const index = bmi(weightKg, heightMm);

  if (index < 19.5) {
    return 'climber';
  }

  if (index < 20.5) {
    return 'gc';
  }

  if (index < 21.5) {
    return 'hills';
  }

  return index < 22.5 ? 'oneday' : 'sprinter';
}

/** How much stronger than you a rider is, by its place in the rankings. */
export function rankStrength(rank: number): number {
  if (rank <= 0) {
    return 1.15;
  }

  if (rank < 10) {
    return 1.12;
  }

  if (rank < 50) {
    return 1.08;
  }

  return rank < 200 ? 1.04 : 1;
}

export function buildRange(specialty: Specialty, isMale: boolean): BuildRange {
  return (isMale ? MALE_BUILDS : FEMALE_BUILDS)[specialty];
}

export function isPlaceholderBuild(weightInGrams: number, heightInMillimeters: number): boolean {
  return weightInGrams === PLACEHOLDER_WEIGHT_G && heightInMillimeters === PLACEHOLDER_HEIGHT_MM;
}

/** The body type with its size chosen from the BMI, as the game does for your own avatar. */
export function sizedBodyType(bodyType: number, weightKg: number, heightMm: number, isMale: boolean): number {
  const index = bmi(weightKg, heightMm);

  const size = isMale
    ? index < MALE_SMALL_BMI
      ? SIZE_SMALL
      : index > MALE_LARGE_BMI
        ? SIZE_LARGE
        : SIZE_MEDIUM
    : index < FEMALE_SMALL_BMI
      ? SIZE_SMALL
      : SIZE_MEDIUM;

  return (bodyType & ~SIZE_MASK) | size;
}

export interface BlobRiderFigures {
  /** The rider's power is your power times this: your W/kg, its strength and its weight. */
  powerScale: number;
  /** The FTP of its profile, which decides when the game stands it up. */
  ftp: number;
}

export function blobRiderFigures(
  owner: { ftp: number; weightKg: number },
  rider: { weightKg: number; rank: number; specialty: Specialty },
): BlobRiderFigures {
  const ownerKg = owner.weightKg > 0 ? owner.weightKg : FALLBACK_OWNER_KG;
  const strength = rankStrength(rider.rank);
  const powerScale = (strength * rider.weightKg) / ownerKg;

  return {
    powerScale,
    ftp: Math.round(((owner.ftp * powerScale) / 2) * STAND_RATIO[rider.specialty]),
  };
}
