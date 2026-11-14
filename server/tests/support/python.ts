import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const pythonFixtures = z
  .object({
    key: z.string(),
    payload: z.string(),
    packets: z.array(z.object({ flags: z.number(), wire: z.string(), decrypted: z.string() })),
    credentialKey: z.string(),
    credentials: z.string(),
    password: z.string(),
    scryptHash: z.string(),
    sha256Hash: z.string(),
    profile: z.string(),
    secret: z.string(),
    identity: z.string(),
    cookie: z.string(),
  })
  .parse(JSON.parse(readFileSync(new URL('../fixtures/python.json', import.meta.url), 'utf8')));
