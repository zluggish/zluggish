import { z } from 'zod';
import { HttpMethod, ResponseMode } from '#src/enum';

export const staticResponseSchema = z.object({
  methods: z.array(z.enum(HttpMethod)),
  path: z.string(),
  body: z.json(),
  mode: z.enum(ResponseMode),
  authenticated: z.boolean(),
  status: z.union([
    z.literal(200),
    z.literal(201),
    z.literal(202),
    z.literal(204),
    z.literal(400),
    z.literal(404),
    z.literal(500),
  ]),
});
