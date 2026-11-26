import { Schema, Option } from 'effect';

export const climbProfileSchema = Schema.Struct({
  distanceM: Schema.Number.check(Schema.isGreaterThan(0)),
  elevationLowM: Schema.Number,
  elevationHighM: Schema.Number,
  avgGradePct: Schema.Number,
  maxGradePct: Schema.Number,
  category: Schema.NullOr(Schema.Literals(['HC', '1', '2', '3', '4'])),
  points: Schema.Array(Schema.Tuple([Schema.Number, Schema.Number])).check(Schema.isMinLength(2)),
});

export type ClimbProfile = typeof climbProfileSchema.Type;

/** Parse a JSON object of climb profiles keyed by road id; invalid JSON or non-object gives {}. */
export function parseClimbProfiles(text: string): Record<string, ClimbProfile> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }

  const recordOption = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))(parsed);

  if (Option.isNone(recordOption)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(recordOption.value).flatMap(([road, value]) => {
      const entryOption = Schema.decodeUnknownOption(climbProfileSchema)(value);

      if (Option.isNone(entryOption)) {
        return [];
      }

      return [[road, entryOption.value]];
    }),
  );
}
