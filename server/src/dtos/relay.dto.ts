import { z } from 'zod';

export const eventFeedSchema = z.object({ data: z.array(z.object({ event: z.json() })) });
