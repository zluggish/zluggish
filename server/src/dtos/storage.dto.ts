import { z } from 'zod';

export const fileUploadSchema = z.object({
  folder: z.string(),
  name: z.string(),
  content: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
