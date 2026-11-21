import { Schema } from 'effect';

const garminSuccessSchema = Schema.Struct({
  internalId: Schema.Union([
    Schema.Int.check(Schema.isGreaterThan(0)),
    Schema.String.check(Schema.isPattern(/^[1-9]\d*$/)),
  ]),
});

const garminImportSchema = Schema.Struct({
  detailedImportResult: Schema.Struct({
    successes: Schema.Array(garminSuccessSchema),
  }),
});

export type GarminImport = typeof garminImportSchema.Type;

export const decodeGarminImport = Schema.decodeUnknownOption(garminImportSchema);

/** Extract the Garmin Connect activity id from an upload response. */
export function garminActivityId(response: GarminImport): string | null {
  const first = response.detailedImportResult.successes.at(0);

  if (!first) {
    return null;
  }

  return String(first.internalId);
}

const intervalsIdSchema = Schema.Union([Schema.String.check(Schema.isPattern(/.+/)), Schema.Number]);

const intervalsItemSchema = Schema.Struct({ id: intervalsIdSchema });

const intervalsImportSchema = Schema.Union([
  intervalsItemSchema,
  Schema.Array(intervalsItemSchema).check(Schema.isMinLength(1)),
]);

export type IntervalsImport = typeof intervalsImportSchema.Type;

export const decodeIntervalsImport = Schema.decodeUnknownOption(intervalsImportSchema);

/** Extract the Intervals.icu activity id from a creation response. */
export function intervalsActivityId(response: IntervalsImport): string | null {
  if ('id' in response) {
    return String(response.id);
  }

  const first = response.at(0);

  if (!first) {
    return null;
  }

  return String(first.id);
}
