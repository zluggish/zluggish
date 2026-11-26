import { t } from '#src/i18n/index';
import { Context, Effect, Layer } from 'effect';
import { RuntimeContext } from '#src/context';
import { SocialPlayerActionSchema, SocialPlayerActionType } from '#src/protocol/generated/tcp-node-msgs_pb';
import { WA_TYPE, WorldAttributeSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { worldTime } from '#src/world/state';
import { create, toBinary } from '@bufbuild/protobuf';

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;

  const sendMessage = Effect.fn('MessageService.sendMessage')(function* (
    message: string,
    recipients?: Array<bigint>,
    sender: string = 'Server',
  ) {
    if (sender === 'Server' && recipients === undefined) {
      for (const bridge of context.bridges ?? []) {
        bridge.send(message);
      }
    }
    context.world.enqueue(
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
            firstName: sender === 'Server' ? t('server') : sender,
            lastName: '',
            message,
            countryCode: 0,
          }),
        ),
      }),
      recipients,
    );
  });

  return { sendMessage };
});

export class MessageService extends Context.Service<MessageService, Effect.Success<typeof make>>()(
  'zluggish/MessageService',
) {
  static readonly layer = Layer.effect(MessageService, make);
}
