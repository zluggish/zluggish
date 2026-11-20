/** Categorize a climb by its score (distance × average grade). */
export type ClimbCategory = 'HC' | '1' | '2' | '3' | '4';

/** Return the climb category based on score thresholds, or null if below all thresholds. */
export function climbCategory(distanceM: number, avgGradePct: number): ClimbCategory | null {
  const score = distanceM * avgGradePct;

  if (score >= 80_000) {
    return 'HC';
  }

  if (score >= 64_000) {
    return '1';
  }

  if (score >= 32_000) {
    return '2';
  }

  if (score >= 16_000) {
    return '3';
  }

  if (score >= 8000) {
    return '4';
  }

  return null;
}

/** Return a two-point straight-line elevation profile from origin to the summit. */
export function straightProfile(distanceM: number, elevationM: number): Array<[number, number]> {
  return [
    [0, 0],
    [distanceM, elevationM],
  ];
}
