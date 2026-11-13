import { ActivitySport, MeetupInviteStatus } from '#src/enum';
import { z } from 'zod';

export const inputSchema = z.object({
  culling: z.boolean().default(false),
  description: z.string().default(''),
  distanceInMeters: z.number().nonnegative(),
  durationInSeconds: z.number().int().nonnegative(),
  eventStart: z.iso.datetime(),
  invitedProfileIds: z.array(z.number().int().positive().safe()).max(100),
  laps: z.number().int().nonnegative(),
  routeId: z.number().int().nonnegative().safe(),
  rubberbanding: z.boolean(),
  showResults: z.boolean(),
  sport: z.enum(ActivitySport),
  workoutHash: z.number().int().nonnegative().safe(),
});

const profileSchema = z
  .object({
    id: z.number().int().positive(),
    firstName: z.string(),
    lastName: z.string(),
    male: z.boolean(),
    imageSrc: z.string().nullable(),
    playerType: z.string(),
    enrolledZwiftAcademy: z.boolean(),
  })
  .passthrough();

const inviteSchema = z.object({
  invitedProfile: profileSchema,
  status: z.enum(MeetupInviteStatus),
});

export const storedSchema = inputSchema.extend({
  id: z.number(),
  eventSubgroupId: z.number(),
  name: z.string(),
  organizerProfileId: z.number(),
  organizerId: z.number(),
  organizerFirstName: z.string(),
  organizerLastName: z.string(),
  organizerImageUrl: z.string().nullable(),
  updateDate: z.string(),
  invitedTotalCount: z.number(),
  acceptedTotalCount: z.number(),
  acceptedFolloweeCount: z.number(),
  startLocation: z.number(),
  allowsLateJoin: z.boolean(),
  eventInvites: z.array(inviteSchema),
});

export type Meetup = z.infer<typeof storedSchema>;

export type MeetupInput = z.infer<typeof inputSchema>;
