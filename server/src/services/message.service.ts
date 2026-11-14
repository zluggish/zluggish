import type { RepositoryContext } from '#src/context';
import { SocialPlayerActionSchema, SocialPlayerActionType } from '#src/protocol/generated/tcp-node-msgs_pb';
import { WA_TYPE, WorldAttributeSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { BaseService } from '#src/services/base.service';
import { worldTime } from '#src/world/state';
import { create, toBinary } from '@bufbuild/protobuf';

export class MessageService extends BaseService {
  sendMessage(runtime: RepositoryContext, message: string, recipients?: bigint[], sender = 'Server') {
    if (sender === 'Server' && recipients === undefined) runtime.discord?.send(message);
    runtime.world.enqueue(
      create(WorldAttributeSchema, {
        serverRealm: 1n,
        waType: WA_TYPE.WAT_SPA,
        worldTimeBorn: worldTime(),
        worldTimeExpire: worldTime() + 60_000n,
        waF12: 1n,
        timestamp: BigInt(Date.now()) * 1000n,
        payload: toBinary(
          SocialPlayerActionSchema,
          create(SocialPlayerActionSchema, {
            playerId: 0n,
            toPlayerId: 0n,
            spaType: SocialPlayerActionType.SOCIAL_TEXT_MESSAGE,
            firstName: sender,
            lastName: '',
            message,
            countryCode: 0,
          }),
        ),
      }),
      recipients,
    );
  }
}
