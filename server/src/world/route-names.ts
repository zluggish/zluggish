import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const gameInfo = z.object({
  maps: z.array(z.object({ routes: z.array(z.object({ id: z.number(), name: z.string() })).default([]) })),
});

/** Names of the routes by route id (the hash that the game sends in a route result), from data/game_info.txt. */
export function loadRouteNames(assets: string) {
  const text = readFileSync(resolve(assets, 'data/game_info.txt'), 'utf8').replace(/^\u{FEFF}/u, '');
  const names = new Map<number, string>();

  for (const map of gameInfo.parse(JSON.parse(text)).maps)
    for (const route of map.routes) if (route.name) names.set(route.id, route.name);

  return names;
}

/** The game sends only the name of the workout as the title of an activity: add the route to it. */
export function titleWithRoute(title: string, route: string | undefined) {
  if (!route || !title || title.includes(route)) return title;

  return `${title} - ${route}`;
}
