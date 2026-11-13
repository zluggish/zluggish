import { ImportFile as ImportFilename, ImportState } from '#src/enum';
import { z } from 'zod';

export const importFilenameSchema = z.enum(ImportFilename);

export type ImportFile = z.infer<typeof importFilenameSchema>;

export type ImportFiles = Partial<Record<ImportFile, Uint8Array>>;

export const filenameSchema = importFilenameSchema;

export const manifestSchema = z.object({
  playerId: z.number().int().positive(),
  authVersion: z.number().int(),
  sourceId: z.string().nullable(),
  firstName: z.string(),
  lastName: z.string(),
  files: z.array(filenameSchema),
  before: z.object({
    firstName: z.string(),
    lastName: z.string(),
    officialPlayerId: z.string().nullable(),
  }),
  state: z.enum(ImportState),
});

export type ImportManifest = z.infer<typeof manifestSchema>;
