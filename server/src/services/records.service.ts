import type { RepositoryContext } from '#src/context';
import { SegmentResultSchema } from '#src/protocol/generated/segment-result_pb';
import { RecordsRepository } from '#src/repositories/records.repository';
import { AchievementService } from '#src/services/achievement.service';
import { BaseService } from '#src/services/base.service';

export class RecordsService extends BaseService {
  constructor(private readonly context: RepositoryContext) {
    super(context.accounts.repositories);
  }
  updateRouteResult(...values: Parameters<RecordsRepository['updateRouteResult']>) {
    return this.recordsRepository.updateRouteResult(...values);
  }
  listRouteResult(...values: Parameters<RecordsRepository['listRouteResult']>) {
    return this.recordsRepository.listRouteResult(...values);
  }
  findPrivateEvent(...values: Parameters<RecordsRepository['findPrivateEvent']>) {
    return this.recordsRepository.findPrivateEvent(...values);
  }

  mine(playerId: number, sport?: string, segment?: string) {
    return this.protobufRepository
      .select('segment_result', SegmentResultSchema, BigInt(playerId))
      .filter(
        (result) =>
          (sport === undefined || result.sport === (sport === 'RUNNING' ? 1 : 0)) &&
          (segment === undefined || result.segmentId === BigInt(segment)),
      );
  }

  segmentLeaderboard(...values: Parameters<RecordsRepository['segmentLeaderboard']>) {
    return this.recordsRepository.segmentLeaderboard(...values);
  }

  backfillRoutes(id: number) {
    return new AchievementService(this.repositories).backfillRoutes(this.context, id);
  }
}
