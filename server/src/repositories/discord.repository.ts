import type { RepositoryContext as Runtime } from '#src/context';
import { ActivityType, Client, Events, GatewayIntentBits, WebhookClient } from 'discord.js';
import { parse } from 'ini';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

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
    const credentials = z
      .object({
        discord: z.object({ token: z.string().min(1), webhook: z.url() }),
      })
      .parse(parse(readFileSync(settings.credentialsFile, 'utf8'))).discord;

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
        if (client.isReady())
          client.user.setPresence({
            activities: count
              ? [
                  {
                    name: `${count} rider${count === 1 ? '' : 's'} online`,
                    type: ActivityType.Playing,
                  },
                ]
              : [],
          });
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
