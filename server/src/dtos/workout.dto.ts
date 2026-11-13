import { z } from 'zod';

export const uuid = z.uuidv4();

export const metadataSchema = z.object({
  provider: z.string(),
  event_id: z.union([z.string(), z.number()]).nullable().optional(),
  workout_id: z.string().optional(),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  start_date_local: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  icu_training_load: z.number().nullable().optional(),
});

export const identifier = z.union([z.string(), z.number()]);

/** Loose on purpose: unread provider fields must survive a rewrite. */
export const storedEntrySchema = z.looseObject({
  event_id: identifier.nullish(),
  id: identifier.nullish(),
  workout_id: z.string().nullish(),
  name: z.string().nullish(),
  start_date_local: z.string().nullish(),
  start_date: z.string().nullish(),
  synced_for_date: z.string().nullish(),
});

export type StoredEntry = z.infer<typeof storedEntrySchema>;
