import { z } from 'zod';

export const userSchema = z.object({
  player_id: z.number(),
  username: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  role: z.string(),
  enabled: z.number(),
  revision: z.number(),
  has_password: z.boolean(),
  connected: z.boolean(),
  avatar: z.number().nullable(),
  /** Set when disabling a rider leaves the current ride time to be saved. */
  completion_deadline: z.number().nullable().optional(),
});

export type User = z.infer<typeof userSchema>;

export const setupUserSchema = userSchema.pick({
  player_id: true,
  username: true,
  first_name: true,
  last_name: true,
  enabled: true,
  has_password: true,
});

export type SetupUser = z.infer<typeof setupUserSchema>;

export const setupResponse = z.object({ complete: z.boolean(), version: z.string(), zwiftVersion: z.string() });

export const signedInResponse = z.object({ user: userSchema });

export const setupKeyResponse = z.object({ users: z.array(setupUserSchema) });

export const usersResponse = z.object({ users: z.array(userSchema) });

export const profileResponse = z.object({ user: userSchema, birthday: z.string(), avatar: z.number().nullable() });

export const avatarResponse = z.object({ avatar: z.number().nullable() });

const worldValue = z.union([z.string(), z.number(), z.boolean()]);

export const worldSettingSchema = z.object({
  id: z.string(),
  revision: z.number(),
  overrides: z.record(z.string(), z.json()),
  fields: z.array(z.object({ name: z.string(), kind: z.enum(['boolean', 'number', 'string']), value: worldValue })),
});

export type WorldSetting = z.infer<typeof worldSettingSchema>;

export const serverSettingsResponse = z.object({
  worldSettings: z.array(worldSettingSchema),
  configuration: z.array(z.tuple([z.string(), z.string()])),
});

/** A saved world setting without its fields, which the server only lists. */
export const savedWorldSettingResponse = worldSettingSchema.pick({ id: true, revision: true, overrides: true });

export const managedEventSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string(),
  eventStart: z.string(),
  updateDate: z.string(),
});

export type ManagedEvent = z.infer<typeof managedEventSchema>;

export const eventsResponse = z.object({ events: z.array(managedEventSchema) });

export const backupResponse = z.object({ state: z.string(), name: z.string() });

export const outcomeResponse = z.object({ ok: z.boolean(), message: z.string().nullable() });

export const serverLogsResponse = z.object({ entries: z.array(z.string()) });

export const userSettingsSchema = z.object({
  revision: z.number(),
  overrides: z.record(z.string(), z.union([z.boolean(), z.string()])),
  defaults: z.object({
    ghosts: z.object({ enabled: z.boolean() }),
    uploads: z.object({
      strava: z.object({ method: z.string() }),
      garmin: z.object({ photos: z.object({ enabled: z.boolean() }) }),
    }),
    workouts: z.object({ trainingpeaks: z.object({ bridgeFolder: z.string() }) }),
  }),
});

export type UserSettings = z.infer<typeof userSettingsSchema>;
