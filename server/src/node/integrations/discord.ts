import { Client, Events, GatewayIntentBits, ActivityType, WebhookClient } from 'discord.js';
import { parse } from 'ini';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Runtime } from '#src/http/runtime';
import { sendMessage } from '#src/http/routes/social';

export interface DiscordTransport {
  send(content: string, username: string): Promise<void>;
  presence(count: number): void;
  close(): Promise<void>;
}

/** All external work is bounded and detached from the ride tick. */
export class DiscordBridge {
  private pending = 0;
  private closed = false;
  constructor(
    readonly runtime: Runtime,
    readonly transport: DiscordTransport,
  ) {}
  receive(channel: string, author: string, bot: boolean, content: string) {
    const settings = this.runtime.config.integrations.discord;

    if (this.closed || bot || channel !== String(settings.channel)) return;

    if (content === '!online') this.send(`${this.runtime.world.online.size} riders online`);
    else if (content === '!ping') this.send('pong');
    else if (content === '!help' && settings.helpMessage) this.send(settings.helpMessage);
    else if (!content.startsWith('!')) sendMessage(this.runtime, content.slice(0, 2000), undefined, author);
  }
  welcome(member: string) {
    const message = this.runtime.config.integrations.discord.welcomeMessage;

    if (message) this.send(`${member}\n${message}`);
  }
  send(content: string, sender = 'Server') {
    if (this.closed || this.pending >= 100) return;
    this.pending++;
    void this.transport
      .send(content.slice(0, 2000), sender.slice(0, 80))
      .catch(() => {
        console.warn('Discord delivery failed');
      })
      .finally(() => {
        this.pending--;
      });
  }
  online(id: bigint, joining: boolean) {
    this.transport.presence(this.runtime.world.online.size);

    if (!this.runtime.config.integrations.discord.announcePlayers) return;
    const profile = this.runtime.profiles.get(Number(id));
    this.send(joining ? 'Riding' : 'Leaving', `${profile.firstName} ${profile.lastName}`);
  }
  async close() {
    this.closed = true;
    await this.transport.close();
  }
}

export function startDiscord(runtime: Runtime) {
  const settings = runtime.config.integrations.discord;

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

  const bridge = new DiscordBridge(runtime, {
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
  });

  client.on(Events.MessageCreate, (message) =>
    bridge.receive(message.channelId, message.author.username, message.author.bot, message.content),
  );
  client.on(Events.GuildMemberAdd, (member) => bridge.welcome(member.displayName));
  client.on(Events.ClientReady, () => bridge.transport.presence(runtime.world.online.size));
  client.on(Events.Error, () => console.warn('Discord connection failed'));
  void client
    .login(credentials.token)
    .catch(() => console.warn('Discord login failed; local riding remains available'));

  return bridge;
}
