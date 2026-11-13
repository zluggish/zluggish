import { packageRoot } from '#src/config/load';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const dictionary = z
  .object({ bikeframes: z.record(z.string(), z.string()) })
  .parse(JSON.parse(readFileSync(resolve(packageRoot(), '../assets/data/game_dictionary.txt'), 'utf8')));

export class ProfileJsonRepository {
  bikeFrameName(id: number) {
    return dictionary.bikeframes[String(id)] ?? '---';
  }
}
