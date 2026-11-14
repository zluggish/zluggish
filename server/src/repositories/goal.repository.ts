import type { Goal } from '#src/protocol/generated/goal_pb';
import { GoalSchema } from '#src/protocol/generated/goal_pb';
import { query, SqliteExecutor } from '#src/db/query';
import { sql } from 'kysely';
import type { DatabaseSync } from 'node:sqlite';
import { ProtobufRows } from '#src/repositories/protobuf.repository';
import { z } from 'zod';

export class GoalRepository {
  private readonly records: ProtobufRows;

  private readonly executor: SqliteExecutor;

  constructor(db: DatabaseSync) {
    this.records = new ProtobufRows(db);
    this.executor = new SqliteExecutor(db);
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
    return !!this.executor.get(
      query.selectFrom('goal').select('id').where('id', '=', id).where('player_id', '=', playerId),
    );
  }

  delete(playerId: number, id: bigint) {
    this.executor.run(query.deleteFrom('goal').where('id', '=', id).where('player_id', '=', playerId));
  }

  activityTotals(playerId: bigint, sport: number, start: Date, end: Date) {
    return z.object({ distance: z.number().nullable(), duration: z.number().nullable() }).parse(
      this.executor.get(
        query
          .selectFrom('activity')
          .select([
            sql<number | null>`sum(distanceInMeters)`.as('distance'),
            sql<number | null>`sum((julianday(end_date) - julianday(start_date)) * 1440)`.as('duration'),
          ])
          .where('player_id', '=', playerId)
          .where('sport', '=', sport)
          .where(sql<number>`julianday(start_date)`, '>=', sql<number>`julianday(${start.toISOString()})`)
          .where(sql<number>`julianday(start_date)`, '<=', sql<number>`julianday(${end.toISOString()})`),
      ),
    );
  }
}
