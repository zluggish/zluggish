import { t } from '#src/i18n/index';
import { Context, Effect, Layer } from 'effect';
import { RuntimeContext } from '#src/context';
import type { DiscordTransport } from '#src/repositories/discord.repository';
import { ChatService } from '#src/services/chat-bridge.service';

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const chats = yield* ChatService;
  const settings = () => context.config.integrations.discord;

  /** The Discord side of the chat bridge over a transport. */
  const bridge = Effect.fn('DiscordService.bridge')(function* (transport: DiscordTransport) {
    const chat = yield* chats.open(
      {
        deliver: (content, sender) => transport.send(content.slice(0, 2000), sender.slice(0, 80)),
        presence: (count) => transport.presence(count),
        close: () => transport.close(),
      },
      t('discord'),
      settings,
    );

    return {
      receive(channel: string, author: string, bot: boolean, content: string) {
        if (chat.closed || bot || channel !== String(settings().channel)) {
          return;
        }
        chat.relay(author, content);
      },
      welcome(member: string) {
        const message = settings().welcomeMessage;

        if (message) {
          chat.send(`${member}\n${message}`);
        }
      },
      send: chat.send,
      online: chat.online,
      close: chat.close,
    };
  });

  const start = Effect.fn('DiscordService.start')(function* () {
    const transport = context.accounts.repositories.discordRepository.openDiscordTransport(settings(), {
      receive: (channel, author, bot, content) => receiver.receive(channel, author, bot, content),
      welcome: (member) => receiver.welcome(member),
      onlineCount: () => context.world.online.size,
      connectionFailed: () =>
        context.world.lifecycle.log.warn('discord.connection_failed', 'Discord connection failed'),
      loginFailed: () =>
        context.world.lifecycle.log.warn(
          'discord.login_failed',
          'Discord login failed; local riding remains available',
        ),
    });

    const receiver = yield* bridge(transport);

    return receiver;
  });

  return { bridge, start };
});

export class DiscordService extends Context.Service<DiscordService, Effect.Success<typeof make>>()(
  'zluggish/DiscordService',
) {
  static readonly layer = Layer.effect(DiscordService, make);
}
