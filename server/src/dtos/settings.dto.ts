import { StravaMethod } from '#src/enum';
import { IntBetween, strict } from '#src/schema';
import { Schema } from 'effect';

export const overrideSchema = Schema.Struct({
  'ghosts.enabled': Schema.optional(Schema.Boolean),
  'uploads.intervals.enabled': Schema.optional(Schema.Boolean),
  'uploads.zwift.enabled': Schema.optional(Schema.Boolean),
  'uploads.strava.method': Schema.optional(Schema.Enum(StravaMethod)),
  'devices.zwiftClick.enabled': Schema.optional(Schema.Boolean),
  'workouts.trainingpeaks.bridgeFolder': Schema.optional(Schema.String),
});

export type Overrides = typeof overrideSchema.Type;

export type SettingKey = keyof Overrides;

export const settingKeySchema = Schema.Literals(
  // SAFETY: the keys of overrideSchema.fields are exactly the SettingKey union.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  Object.keys(overrideSchema.fields) as [SettingKey, ...Array<SettingKey>],
);

export const preferenceSchema = Schema.Struct({
  playerId: IntBetween(1),
  overrides: overrideSchema,
});

export type Preference = typeof preferenceSchema.Type;

export const decodeOverrides = Schema.decodeUnknownSync(overrideSchema, strict);

export const decodePreference = Schema.decodeUnknownSync(preferenceSchema, strict);

export const decodeSettingKey = Schema.decodeUnknownSync(settingKeySchema);
