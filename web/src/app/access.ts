import { z } from 'zod';

/** Launcher access groups, as `/api/manage/access` and every change to them return them. */
export const accessOverview = z.object({
  configured: z.boolean(),
  groups: z.array(
    z.object({ id: z.number(), name: z.string(), emails: z.array(z.string()), riders: z.array(z.number()) }),
  ),
  seen: z.array(z.object({ email: z.string(), lastSeen: z.number() })),
  ownEmail: z.array(z.object({ playerId: z.number(), email: z.string() })),
  unreachable: z.array(z.number()),
});

export type AccessOverview = z.output<typeof accessOverview>;

export const createdGroup = accessOverview.extend({ id: z.number() });

/** The names of the groups a rider is in, for the rider's own page. */
export function groupsOf(overview: AccessOverview, player: number) {
  return overview.groups.filter((group) => group.riders.includes(player)).map((group) => group.name);
}
