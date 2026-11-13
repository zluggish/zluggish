import type { Goal } from '#src/protocol/generated/goal_pb';
import { GoalSchema } from '#src/protocol/generated/goal_pb';
import type { Accounts } from '#src/repositories/accounts.repository';
import { ProtobufRows } from '#src/repositories/protobuf.repository';
import { z } from 'zod';

export class GoalRepository {
  private readonly records: ProtobufRows;
  constructor(private readonly accounts: Accounts) {
    this.records = new ProtobufRows(accounts.db);
  }
  list(playerId: number) {
    return this.records.select('goal', GoalSchema, BigInt(playerId)).slice(0, 100);
  }
  insert(goal: Goal) {
    return BigInt(this.records.insert('goal', GoalSchema, goal));
  }
  save(goal: Goal) {
    this.records.update('goal', goal.id, GoalSchema, goal);
  }
  exists(playerId: number, id: bigint) {
    return !!this.accounts.db.prepare('SELECT id FROM goal WHERE id=? AND player_id=?').get(id, playerId);
  }
  delete(playerId: number, id: bigint) {
    this.accounts.db.prepare('DELETE FROM goal WHERE id=? AND player_id=?').run(id, playerId);
  }
  activityTotals(playerId: bigint, sport: number, start: Date, end: Date) {
    return z
      .object({ distance: z.number().nullable(), duration: z.number().nullable() })
      .parse(
        this.accounts.db
          .prepare(
            'SELECT SUM(distanceInMeters) AS distance, SUM((julianday(end_date)-julianday(start_date))*1440) AS duration FROM activity WHERE player_id=? AND sport=? AND julianday(start_date) BETWEEN julianday(?) AND julianday(?)',
          )
          .get(playerId, sport, start.toISOString(), end.toISOString()),
      );
  }
}
