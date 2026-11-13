import { z } from 'zod';

export const importFilenameSchema = z.enum([
  'profile.bin',
  'achievements.bin',
  'economy_config.txt',
  'user_storage.bin',
  'streaks.bin',
]);
