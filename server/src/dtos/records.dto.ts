import { z } from 'zod';

export const routeCompletionStatsSchema = z.object({
  route_hash: z.number(),
  first: z.number().nullable(),
  last: z.number().nullable(),
});

export const meetupStartSchema = z.object({ eventStart: z.iso.datetime() });
