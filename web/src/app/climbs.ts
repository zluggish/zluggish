import { z } from 'zod';

const categorySchema = z.enum(['HC', '1', '2', '3', '4']);

export type ClimbCategory = z.infer<typeof categorySchema>;

export const climbSchema = z.object({
  road: z.string(),
  name: z.string(),
  distanceKm: z.number().nullable(),
  elevationM: z.number().nullable(),
  rides: z.number(),
  bestMs: z.number().nullable(),
  lastRide: z.string().nullable(),
  /** The two Strava segments of the climb, as ridden from Watopia and from France. */
  strava: z.object({ watopia: z.number(), france: z.number() }).nullable(),
  category: categorySchema.nullable(),
  avgGradePct: z.number().nullable(),
  maxGradePct: z.number().nullable(),
  elevationLowM: z.number().nullable(),
  elevationHighM: z.number().nullable(),
  profile: z.array(z.tuple([z.number(), z.number()])),
  profileSource: z.enum(['imported', 'estimated']),
});

export type Climb = z.infer<typeof climbSchema>;

export const climbsResponse = z.object({ climbs: z.array(climbSchema), total: z.number() });

export const categoryTabs = ['all', 'HC', '1', '2', '3', '4', 'none'] as const;

export type CategoryTab = (typeof categoryTabs)[number];

export const tabOf = (value: string | null): CategoryTab => categoryTabs.find((tab) => tab === value) ?? 'all';

export const matchesTab = (climb: Climb, tab: CategoryTab): boolean => {
  if (tab === 'all') {
    return true;
  }

  if (tab === 'none') {
    return climb.category === null;
  }

  return climb.category === tab;
};

export const gradeBand = (gradePct: number): 'flat' | 'easy' | 'steady' | 'steep' => {
  if (gradePct < 3) {
    return 'flat';
  }

  if (gradePct < 6) {
    return 'easy';
  }

  if (gradePct < 9) {
    return 'steady';
  }

  return 'steep';
};

export const clock = (ms: number): string => {
  const s = Math.round(ms / 1000);
  const seconds = String(s % 60).padStart(2, '0');

  return s >= 3600
    ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${seconds}`
    : `${Math.floor(s / 60)}:${seconds}`;
};

export const day = (iso: string): string =>
  new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
