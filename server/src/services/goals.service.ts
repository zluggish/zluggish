import { ActivitySport } from '#src/enum';
import type { RepositoryContext } from '#src/context';
import { ApplicationError } from '#src/errors';
import type { Goal } from '#src/protocol/generated/goal_pb';
import { GoalSchema } from '#src/protocol/generated/goal_pb';
import { BaseService } from '#src/services/base.service';
import { create } from '@bufbuild/protobuf';
import { z } from 'zod';

export const goalInput = z.object({
  id: z.number().int().nonnegative().default(0),
  profileId: z.number().int().positive(),
  sport: z.enum(ActivitySport),
  name: z.string(),
  type: z.union([z.literal(0), z.literal(1)]),
  periodicity: z.union([z.literal(0), z.literal(1)]),
  targetDistanceInMeters: z.number(),
  targetDurationInMinutes: z.number(),
  actualDistanceInMeters: z.number().default(0),
  actualDurationInMinutes: z.number().default(0),
});

export class GoalService extends BaseService {
  constructor(context: RepositoryContext) {
    super(context.accounts.repositories);
  }

  create(playerId: number, goal: Goal) {
    goal.playerId = BigInt(playerId);
    goal.createdOn = BigInt(Date.now());
    this.progress(goal);
    goal.id = this.goalRepository.insert(goal);

    return goal;
  }

  list(playerId: number) {
    const goals = this.goalRepository.list(playerId);

    for (const goal of goals) {
      this.progress(goal);
      this.goalRepository.save(goal);
    }

    return goals;
  }

  update(playerId: number, id: bigint, goal: Goal) {
    this.requireOwned(playerId, id);
    goal.id = id;
    goal.playerId = BigInt(playerId);
    this.goalRepository.save(goal);
  }

  delete(playerId: number, id: bigint) {
    this.requireOwned(playerId, id);
    this.goalRepository.delete(playerId, id);
  }

  requireOwned(playerId: number, id: bigint) {
    if (!this.goalRepository.exists(playerId, id)) throw new ApplicationError(404);
  }

  private progress(goal: Goal) {
    const now = new Date();

    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    let end: Date;

    if (goal.periodicity === 0) {
      start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
      end = new Date(start.getTime() + 7 * 86_400_000 - 1000);
    } else {
      start.setUTCDate(1);
      end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1) - 1000);
    }

    goal.periodEndDate = BigInt(end.getTime());

    const totals = this.goalRepository.activityTotals(goal.playerId, goal.sport, start, end);

    // Companion expects both fields to carry the selected goal metric.
    const actual = (goal.type === 0 ? totals.distance : totals.duration) ?? 0;
    goal.actualDistance = actual;
    goal.actualDuration = actual;
  }

  static jsonGoal(goal: Goal) {
    const timestamp = (time: bigint) => (time ? new Date(Number(time)).toISOString().replace('Z', '+0000') : null);

    return {
      id: Number(goal.id),
      profileId: Number(goal.playerId),
      sport: goal.sport === 1 ? 'RUNNING' : 'CYCLING',
      name: goal.name,
      type: goal.type,
      periodicity: goal.periodicity,
      targetDistanceInMeters: goal.targetDistance,
      targetDurationInMinutes: goal.targetDuration,
      actualDistanceInMeters: goal.actualDistance,
      actualDurationInMinutes: goal.actualDuration,
      createdOn: timestamp(goal.createdOn),
      periodEndDate: timestamp(goal.periodEndDate),
      status: goal.status,
      timezone: goal.timezone,
    };
  }

  static parseGoal(body: z.infer<typeof goalInput>) {
    return create(GoalSchema, {
      id: BigInt(body.id),
      playerId: BigInt(body.profileId),
      sport: body.sport === 'RUNNING' ? 1 : 0,
      name: body.name,
      type: body.type,
      periodicity: body.periodicity,
      status: 0,
      targetDistance: body.targetDistanceInMeters,
      targetDuration: body.targetDurationInMinutes,
      actualDistance: body.actualDistanceInMeters,
      actualDuration: body.actualDurationInMinutes,
    });
  }
}
