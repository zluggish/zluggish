import { climbSchema } from '#src/dtos/accounts.dto';
import type { HttpRuntime } from '#src/http/runtime';
import { resolve } from 'node:path';
import { Effect, Schema } from 'effect';
import { FilesService } from '#src/services/files.service';
import { climbCategory, straightProfile } from '#src/world/climb-category';
import type { ClimbCategory } from '#src/world/climb-category';
import { parseClimbProfiles } from '#src/world/climb-profile';
import type { ClimbProfile } from '#src/world/climb-profile';

const climbSegments = Schema.Record(
  Schema.String,
  Schema.Struct({
    watopia: Schema.Int.check(Schema.isGreaterThan(0)),
    france: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
);

/** The Strava segments of a climb portal road: the climb as ridden from Watopia and from France, by road. */
export const readClimbSegments = Effect.fn('climbs.segments')(function* (runtime: HttpRuntime) {
  const files = yield* FilesService;

  return Schema.decodeUnknownSync(climbSegments)(
    JSON.parse(yield* files.readText(resolve(runtime.assets, 'data/climb_segments.txt'))),
  );
});

/** 'Cauberg (0.8 km / 57 m)' -> the bare name with its length and height; names in another form stay whole. */
export function climbFacts(label: string) {
  const match = /^(?<name>.+) \((?<km>\d+(?:\.\d+)?) km \/ (?<m>\d+) m\)$/.exec(label);

  if (!match?.groups) {
    return { name: label, distanceKm: null, elevationM: null };
  }

  return { name: match.groups.name ?? label, distanceKm: Number(match.groups.km), elevationM: Number(match.groups.m) };
}

/** The climb portal roads the launcher offers, with their display names. */
export const readClimbs = Effect.fn('climbs.read')(function* (runtime: HttpRuntime) {
  const files = yield* FilesService;

  return Schema.decodeUnknownSync(Schema.Array(climbSchema))(
    JSON.parse(yield* files.readText(resolve(runtime.assets, 'data/climbs.txt'))),
  );
});

/** Read climb profiles from the assets directory; returns {} if the file is missing or unreadable. */
export const readClimbProfiles = Effect.fn('climbs.profiles')(function* (runtime: HttpRuntime) {
  const files = yield* FilesService;

  const text = yield* files
    .readText(resolve(runtime.assets, 'data/climb_profiles.txt'))
    .pipe(Effect.orElseSucceed(() => ''));

  return parseClimbProfiles(text);
});

export type ClimbDetails = {
  category: ClimbCategory | null;
  avgGradePct: number | null;
  maxGradePct: number | null;
  elevationLowM: number | null;
  elevationHighM: number | null;
  profile: ReadonlyArray<readonly [number, number]>;
  profileSource: 'imported' | 'estimated';
};

/** Compute climb details from a profile or from distance/elevation facts. */
export function climbDetails(
  facts: { distanceKm: number | null; elevationM: number | null },
  profile: ClimbProfile | undefined,
): ClimbDetails {
  if (profile) {
    return {
      category: profile.category ?? climbCategory(profile.distanceM, profile.avgGradePct),
      avgGradePct: profile.avgGradePct,
      maxGradePct: profile.maxGradePct,
      elevationLowM: profile.elevationLowM,
      elevationHighM: profile.elevationHighM,
      profile: profile.points,
      profileSource: 'imported',
    };
  }

  if (facts.distanceKm === null || facts.elevationM === null) {
    return {
      category: null,
      avgGradePct: null,
      maxGradePct: null,
      elevationLowM: null,
      elevationHighM: null,
      profile: [],
      profileSource: 'estimated',
    };
  }

  const distanceM = facts.distanceKm * 1000;
  const avg = (facts.elevationM / distanceM) * 100;

  return {
    category: climbCategory(distanceM, avg),
    avgGradePct: Math.round(avg * 10) / 10,
    maxGradePct: null,
    elevationLowM: null,
    elevationHighM: null,
    profile: straightProfile(distanceM, facts.elevationM),
    profileSource: 'estimated',
  };
}

export { climbProfileSchema, parseClimbProfiles, type ClimbProfile } from '#src/world/climb-profile';
