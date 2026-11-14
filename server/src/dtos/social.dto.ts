import { z } from 'zod';
import { ActivityPrivacy } from '#src/enum';

export const profileSearchSchema = z.object({ query: z.string() });

export const privacyUpdateSchema = z.object({
  approvalRequired: z.boolean(),
  displayWeight: z.boolean().default(false),
  minor: z.boolean().default(false),
  privateMessaging: z.boolean(),
  defaultFitnessDataPrivacy: z.boolean(),
  suppressFollowerNotification: z.boolean().default(false),
  displayAge: z.boolean(),
  defaultActivityPrivacy: z.enum(ActivityPrivacy),
});

export const companionConnectionSchema = z.object({
  phoneAddress: z.string().max(255),
  port: z.number().int().min(1).max(65_535).optional(),
  securePort: z.number().int().min(1).max(65_535).optional(),
  secret: z.string().optional(),
});

export const playbackRecordSchema = z.object({
  uuid: z.string(),
  segment_id: z.bigint(),
  time: z.number(),
  world_time: z.bigint(),
});
