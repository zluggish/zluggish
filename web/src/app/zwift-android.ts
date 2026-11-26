import { z } from 'zod';

const app = z.object({
  versionName: z.string(),
  versionCode: z.number(),
  bytes: z.number(),
  createdAt: z.string(),
  current: z.boolean(),
});

export const zwiftAndroidStatus = z.object({ app: app.nullable() });

const step = z.enum([
  'download',
  'extract',
  'certificate',
  'inspect',
  'runtime',
  'editor',
  'merge',
  'decode',
  'rename',
  'build',
  'sign',
  'publish',
]);

export const zwiftAndroidAdminStatus = zwiftAndroidStatus.extend({
  activity: z
    .object({
      kind: z.enum(['upload', 'rebuild', 'download']),
      state: z.enum(['running', 'done', 'failed']),
      steps: z.array(step),
      step,
      progress: z.number().nullable(),
      message: z.string().nullable(),
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
    })
    .nullable(),
  original: z.object({ name: z.string(), bytes: z.number(), uploadedAt: z.string() }).nullable(),
  tools: z.object({ ready: z.boolean(), downloadBytes: z.number(), supported: z.boolean() }),
  tlsMode: z.enum(['managed', 'legacy', 'custom']),
  disk: z.object({ free: z.number().nullable(), recommended: z.number() }),
  uploadLimit: z.number(),
  chunkSize: z.number(),
});

export const zwiftAndroidUpload = z.object({ id: z.uuid(), offset: z.int().nonnegative(), size: z.int() });

export type ZwiftAndroidStatus = z.infer<typeof zwiftAndroidStatus>;
export type ZwiftAndroidAdminStatus = z.infer<typeof zwiftAndroidAdminStatus>;
export type ZwiftAndroidStep = z.infer<typeof step>;
