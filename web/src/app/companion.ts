import { z } from 'zod';

export const companionStatus = z.object({
  app: z
    .object({
      versionName: z.string(),
      versionCode: z.number(),
      bytes: z.number(),
      createdAt: z.string(),
      current: z.boolean(),
    })
    .nullable(),
  tlsMode: z.enum(['managed', 'legacy', 'custom']),
  serverAddress: z.string(),
});

const companionStep = z.enum([
  'upload',
  'download',
  'runtime',
  'editor',
  'inspect',
  'merge',
  'decode',
  'patch',
  'build',
  'sign',
  'publish',
]);

const companionActivity = z.object({
  kind: z.enum(['toolchain', 'patch', 'rebuild', 'download', 'rekey']),
  state: z.enum(['running', 'waiting', 'done', 'failed']),
  steps: z.array(companionStep),
  step: companionStep,
  progress: z.number().nullable(),
  message: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});

export const companionAdminStatus = companionStatus.extend({
  toolchain: z.object({
    java: z.object({ source: z.enum(['managed', 'system']), command: z.string(), version: z.string() }).nullable(),
    editor: z.boolean(),
    downloadBytes: z.number(),
    supported: z.boolean(),
    folder: z.string(),
  }),
  activity: companionActivity.nullable(),
  pending: z.boolean(),
  original: z.object({ name: z.string(), bytes: z.number(), uploadedAt: z.string() }).nullable(),
  uploadLimit: z.number(),
});

export type CompanionStatus = z.infer<typeof companionStatus>;
export type CompanionStep = z.infer<typeof companionStep>;
export type CompanionActivity = z.infer<typeof companionActivity>;
export type CompanionAdminStatus = z.infer<typeof companionAdminStatus>;

export function megabytes(bytes: number) {
  return bytes >= 1_000_000_000
    ? `${Math.round(bytes / 100_000_000) / 10} GB`
    : `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}
