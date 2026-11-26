import { z } from 'zod';

export const tlsStatus = z.object({
  mode: z.enum(['managed', 'legacy', 'custom']),
  canRotate: z.boolean(),
  certificate: z
    .object({
      fingerprint256: z.string(),
      thumbprint: z.string(),
      subject: z.string(),
      notBefore: z.string(),
      notAfter: z.string(),
      hosts: z.array(z.string()),
      /** Such as `ECDSA P-256`. */
      key: z.string(),
    })
    .nullable(),
  serverAddress: z.string(),
  lifetimeYears: z.number(),
});

export type TlsStatus = z.infer<typeof tlsStatus>;
