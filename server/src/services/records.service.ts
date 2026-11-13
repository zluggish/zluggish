import type { RepositoryContext } from '#src/context';
import { SegmentResultSchema } from '#src/protocol/generated/segment-result_pb';
import { backfillRoutes } from '#src/services/achievement.service';
import { ProtobufRows } from '#src/repositories/protobuf.repository';
import { RecordsRepository } from '#src/repositories/records.repository';

export class RecordsService {
  constructor(
    private readonly repository: RecordsRepository,
    private readonly records: ProtobufRows,
    private readonly context: RepositoryContext,
  ) {}
  updateRouteResult(...values: Parameters<RecordsRepository['updateRouteResult']>) {
    return this.repository.updateRouteResult(...values);
  }
  listRouteResult(...values: Parameters<RecordsRepository['listRouteResult']>) {
    return this.repository.listRouteResult(...values);
  }
  findPrivateEvent(...values: Parameters<RecordsRepository['findPrivateEvent']>) {
    return this.repository.findPrivateEvent(...values);
  }

  mine(playerId: number, sport?: string, segment?: string) {
    return this.records
      .select('segment_result', SegmentResultSchema, BigInt(playerId))
      .filter(
        (result) =>
          (sport === undefined || result.sport === (sport === 'RUNNING' ? 1 : 0)) &&
          (segment === undefined || result.segmentId === BigInt(segment)),
      );
  }

  segmentLeaderboard(...values: Parameters<RecordsRepository['segmentLeaderboard']>) {
    return this.repository.segmentLeaderboard(...values);
  }

  backfillRoutes(id: number) {
    return backfillRoutes(this.context, id);
  }
}
