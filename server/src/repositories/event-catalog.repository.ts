import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const catalogSchema = z.array(
  z.object({
    name: z.string(),
    route: z.number().int(),
    course: z.number().int(),
    sport: z.union([z.literal(0), z.literal(1)]),
    distance: z.number(),
  }),
);

export class EventCatalogRepository {
  readEventCatalog(assets: string) {
    return catalogSchema.parse(JSON.parse(readFileSync(resolve(assets, 'data/events.txt'), 'utf8')));
  }
}
