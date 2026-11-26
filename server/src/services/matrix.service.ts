import { t } from '#src/i18n/index';
import { Context, Effect, Layer } from 'effect';
import { RuntimeContext } from '#src/context';
import type { MatrixTransport } from '#src/repositories/matrix.repository';
import { ChatService } from '#src/services/chat-bridge.service';

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const chats = yield* ChatService;
  const settings = () => context.config.integrations.matrix;

  /** The Matrix side of the chat bridge over a transport. */
  const bridge = Effect.fn('MatrixService.bridge')(function* (transport: MatrixTransport) {
    const chat = yield* chats.open(
      {
        // A Matrix message has no per-message username, so the sender leads the text.
        deliver: (content, sender) =>
          transport.send((sender === 'Server' ? content : `${sender}: ${content}`).slice(0, 2000)),
        presence: (count) => transport.presence(count),
        close: () => transport.close(),
      },
      t('matrix'),
      settings,
    );

    return {
      receive(author: string, content: string) {
        if (!chat.closed) {
          chat.relay(author, content);
        }
      },
      send: chat.send,
      online: chat.online,
      close: chat.close,
    };
  });

  const start = Effect.fn('MatrixService.start')(function* () {
    const transport = context.accounts.repositories.matrixRepository.openMatrixTransport(
      settings(),
      context.config.storageDir,
      {
        receive: (author, content) => receiver.receive(author, content),
        onlineCount: () => context.world.online.size,
        encrypted: () =>
          context.world.lifecycle.log.warn(
            'matrix.encrypted_room',
            'Matrix room is encrypted; the bridge only supports unencrypted rooms',
          ),
        connectionFailed: () =>
          context.world.lifecycle.log.warn('matrix.connection_failed', 'Matrix connection failed'),
        loginFailed: () =>
          context.world.lifecycle.log.warn(
            'matrix.login_failed',
            'Matrix login failed; local riding remains available',
          ),
      },
    );

    const receiver = yield* bridge(transport);

    return receiver;
  });

  return { bridge, start };
});

export class MatrixService extends Context.Service<MatrixService, Effect.Success<typeof make>>()(
  'zluggish/MatrixService',
) {
  static readonly layer = Layer.effect(MatrixService, make);
}
