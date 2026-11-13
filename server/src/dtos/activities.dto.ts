import { z } from 'zod';

export const activityMediaSchema = z.object({
  id: z.number(),
  player_id: z.number(),
  content_type: z.string(),
});
