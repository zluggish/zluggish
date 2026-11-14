import { z } from 'zod';

export const notificationPayloadSchema = z.object({ argString0: z.string() });

export const notificationEventSchema = z.object({ eventStartDate: z.number() });

export const notificationUpdateSchema = z.object({ read: z.boolean(), readDate: z.string().nullable() });
