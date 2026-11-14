import { PrivateEventFeedListProtoSchema } from '#src/protocol/generated/events_pb';
import { FitnessSchema } from '#src/protocol/generated/fitness_pb';
import { HashSeedsSchema } from '#src/protocol/generated/hash-seeds_pb';
import { RelaySessionRefreshResponseSchema } from '#src/protocol/generated/login_pb';
import { PerSessionInfoSchema, TcpConfigSchema } from '#src/protocol/generated/per-session-info_pb';
import {
  PlayerProfileSchema,
  PlayerProfilesSchema,
  PowerCurveAggregationMsgSchema,
  ProfileEntitlementsSchema,
  StreaksSchema,
} from '#src/protocol/generated/profile_pb';
import { LoadPlayerRouteCompletionAchievementsResponseSchema } from '#src/protocol/generated/route-completion-achievement_pb';
import { DropInWorldListSchema, DropInWorldSchema, TeleportTargetsSchema } from '#src/protocol/generated/world_pb';
import type { DescMessage } from '@bufbuild/protobuf';
import { fromBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';

const schemas = new Map<string, DescMessage>([
  ['/api/profiles/me', PlayerProfileSchema],
  ['/api/profiles/me/', PlayerProfileSchema],
  ['/api/profiles/me/entitlements', ProfileEntitlementsSchema],
  ['/api/profiles', PlayerProfilesSchema],
  ['/relay/session/refresh', RelaySessionRefreshResponseSchema],
  ['/relay/session/renew', RelaySessionRefreshResponseSchema],
  ['/api/fitness/streaks', StreaksSchema],
  ['/api/fitness/metrics-and-goals', FitnessSchema],
  ['/relay/worlds', DropInWorldListSchema],
  ['/relay/dropin', DropInWorldListSchema],
  ['/relay/worlds/1', DropInWorldSchema],
  ['/relay/worlds/1/', DropInWorldSchema],
  ['/relay/teleport-targets', TeleportTargetsSchema],
  ['/relay/worlds/hash-seeds', HashSeedsSchema],
  ['/api/tcp-config', TcpConfigSchema],
  ['/relay/tcp-config', TcpConfigSchema],
  ['/api/per-session-info', PerSessionInfoSchema],
  ['/api/private_event/feed', PrivateEventFeedListProtoSchema],
  ['/api/achievement/route-completion-achievements', LoadPlayerRouteCompletionAchievementsResponseSchema],
  ['/api/power-curve/best/pr', PowerCurveAggregationMsgSchema],
]);

export async function assertProtocol(path: string, response: Response) {
  const schema = schemas.get(path.split('?', 1)[0]!);

  if (!schema) return;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const message = fromBinary(schema, bytes);
  assert.equal(message.$typeName, schema.typeName);
  // A HTML error page with a 200 status must not pass as a protocol response.
  assert.equal(message.$unknown, undefined);
}
