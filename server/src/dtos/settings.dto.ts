import { StravaMethod } from '#src/enum';
import { z } from 'zod';

export const overrideSchema = z.strictObject({
  'ghosts.enabled': z.boolean().optional(),
  'uploads.zwift.enabled': z.boolean().optional(),
  'uploads.strava.method': z.enum(StravaMethod).optional(),
  'devices.zwiftClick.enabled': z.boolean().optional(),
  'workouts.trainingpeaks.bridgeFolder': z.string().optional(),
});

export type Overrides = z.infer<typeof overrideSchema>;

export type SettingKey = keyof Overrides;

export const settingKeySchema = overrideSchema.keyof();

export const preferenceSchema = z.object({
  playerId: z.number().int().positive().safe(),
  overrides: overrideSchema,
});

export type Preference = z.infer<typeof preferenceSchema>;
