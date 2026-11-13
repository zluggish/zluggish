import { z } from 'zod';

export const climbSchema = z.object({ name: z.string(), road: z.string() });

export const createUserSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
  profile: z.object({ firstName: z.string(), lastName: z.string() }),
});
