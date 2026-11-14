import { z } from 'zod';

export const profileUpdateSchema = z.object({
  countryCode: z.number().int().optional(),
  dob: z.string().optional(),
  emailAddress: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  height: z.number().int().positive().optional(),
  male: z.boolean().optional(),
  useMetric: z.boolean().optional(),
  weight: z.number().int().positive().optional(),
});
