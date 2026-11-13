import type { RepositoryContext as Runtime } from '#src/context';
import type { DiscordTransport } from '#src/repositories/discord.repository';
import { openDiscordTransport } from '#src/repositories/discord.repository';
import { sendMessage } from '#src/services/message.service';

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
        this.runtime.world.lifecycle.log.warn('discord.delivery_failed', 'Discord delivery failed');
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
  const transport = openDiscordTransport(runtime.config.integrations.discord, {
    receive: (channel, author, bot, content) => bridge.receive(channel, author, bot, content),
    welcome: (member) => bridge.welcome(member),
    onlineCount: () => runtime.world.online.size,
    connectionFailed: () => runtime.world.lifecycle.log.warn('discord.connection_failed', 'Discord connection failed'),
    loginFailed: () =>
      runtime.world.lifecycle.log.warn('discord.login_failed', 'Discord login failed; local riding remains available'),
  });

  const bridge = new DiscordBridge(runtime, transport);

  return bridge;
}
