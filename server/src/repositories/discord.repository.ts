import { t } from '#src/i18n/index';
import { Schema } from 'effect';
import type { RepositoryContext as Runtime } from '#src/context';
import { ActivityType, Client, Events, GatewayIntentBits, WebhookClient } from 'discord.js';
import { parse } from 'ini';
import { readFileSync } from 'node:fs';
import { Url } from '#src/schema';

export interface DiscordHandlers {
  receive(channel: string, author: string, bot: boolean, content: string): void;
  welcome(member: string): void;
  onlineCount(): number;
  connectionFailed(): void;
  loginFailed(): void;
}

export interface DiscordTransport {
  send(content: string, username: string): Promise<void>;
  presence(count: number): void;
  close(): Promise<void>;
}

export class DiscordRepository {
  openDiscordTransport(settings: Runtime['config']['integrations']['discord'], handlers: DiscordHandlers) {
    const credentials = Schema.decodeUnknownSync(
      Schema.Struct({ discord: Schema.Struct({ token: Schema.String.check(Schema.isMinLength(1)), webhook: Url }) }),
    )(parse(readFileSync(settings.credentialsFile, 'utf8'))).discord;

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      rest: { timeout: 10_000, retries: 0 },
    });

    const webhook = new WebhookClient({ url: credentials.webhook }, { rest: { timeout: 10_000, retries: 0 } });

    const transport: DiscordTransport = {
      send: async (content, username) => {
        await webhook.send({ content, username, allowedMentions: { parse: [] } });
      },
      presence: (count) => {
        if (client.isReady()) {
          client.user.setPresence({
            activities: count
              ? [
                  {
                    name: t('rider_online', { value1: count, value2: count === 1 ? '' : 's' }),
                    type: ActivityType.Playing,
                  },
                ]
              : [],
          });
        }
      },
      close: async () => {
        webhook.destroy();
        await client.destroy();
      },
    };

    client.on(Events.MessageCreate, (message) =>
      handlers.receive(message.channelId, message.author.username, message.author.bot, message.content),
    );
    client.on(Events.GuildMemberAdd, (member) => handlers.welcome(member.displayName));
    client.on(Events.ClientReady, () => transport.presence(handlers.onlineCount()));
    client.on(Events.Error, () => handlers.connectionFailed());
    void client.login(credentials.token).catch(() => handlers.loginFailed());

    return transport;
  }
}
