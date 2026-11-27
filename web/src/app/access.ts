import { z } from 'zod';

/** Launcher access groups, as `/api/manage/access` and every change to them return them. */
export const accessOverview = z.object({
  configured: z.boolean(),
  /** The secret itself is only ever in `gatewaySecret`'s response. */
  gateway: z.object({
    enabled: z.boolean(),
    secretCreatedAt: z.number().nullable(),
    certificate: z.object({ subject: z.string(), notAfter: z.string() }).nullable(),
  }),
  groups: z.array(
    z.object({ id: z.number(), name: z.string(), emails: z.array(z.string()), riders: z.array(z.number()) }),
  ),
  seen: z.array(z.object({ email: z.string(), lastSeen: z.number() })),
  ownEmail: z.array(z.object({ playerId: z.number(), email: z.string() })),
  unreachable: z.array(z.number()),
});

export type AccessOverview = z.output<typeof accessOverview>;

export const createdGroup = accessOverview.extend({ id: z.number() });

/** A newly made Gateway secret: shown once, then gone. */
export const gatewaySecret = accessOverview.extend({ secret: z.string() });

/** The names of the groups a rider is in, for the rider's own page. */
export function groupsOf(overview: AccessOverview, player: number) {
  return overview.groups.filter((group) => group.riders.includes(player)).map((group) => group.name);
}
