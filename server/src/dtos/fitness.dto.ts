import { FitnessGoalSetting } from '#src/enum';
import { z } from 'zod';

export const goalSchema = z.object({
  weekGoalTSS: z.number().nonnegative().default(200),
  weekGoalCalories: z.number().nonnegative().default(2000),
  weekGoalKjs: z.number().nonnegative().default(2000),
  weekGoalDistanceKilometers: z.number().nonnegative().default(100),
  weekGoalDistanceMiles: z.number().nonnegative().default(62.14),
  weekGoalTimeMinutes: z.number().nonnegative().default(180),
  currentGoalSetting: z.enum(FitnessGoalSetting).default('DISTANCE'),
  currentGoalSource: z.string().default('MANUAL'),
  lastUpdated: z.string().default(() => new Date().toISOString()),
});
