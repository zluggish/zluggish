import { LoggingRepository } from '#src/repositories/logging.repository';
import type { Answer } from 'dns-packet';
import { decode, encode, RECURSION_DESIRED } from 'dns-packet';
import { createSocket, type RemoteInfo } from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

const redirected = new Set(['secure.zwift.com', 'us-or-rly101.zwift.com', 'cdn.zwift.com', 'launcher.zwift.com']);

export function startDns(advertisedIp: string, host: string, port = 53, log = new LoggingRepository()) {
  const socket = createSocket(host.includes(':') ? 'udp6' : 'udp4');
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  resolver.setServers(['8.8.8.8', '8.8.4.4']);
  // Cache freshness is derived at lookup; handlers acquire/release one admission slot in try/finally.
  const cache = new Map<string, { ip: string; expires: number }>();
  let pending = 0;

  async function handleMessage(bytes: Buffer, peer: RemoteInfo) {
    if (bytes.length > 4096 || pending >= 64) return;
    pending++;

    try {
      const query = decode(bytes);

      if (query.type !== 'query' || !query.questions?.length || query.questions.length > 16) return;
      const answers: Answer[] = [];

      for (const question of query.questions) {
        if (question.type !== 'A' && question.type !== 'AAAA') continue;
        const name = question.name.toLowerCase().replace(/\.$/, '');
        let ip = redirected.has(name) ? advertisedIp : undefined;

        if (!ip) {
          const key = `${name}:${question.type}`;
          const cached = cache.get(key);
          ip = cached && cached.expires > Date.now() ? cached.ip : undefined;

          if (!ip) {
            try {
              ip = (question.type === 'A' ? await resolver.resolve4(name) : await resolver.resolve6(name))[0];
            } catch {
              continue;
            }

            if (ip) {
              if (cache.size >= 10_000) cache.clear();
              cache.set(key, { ip, expires: Date.now() + 3_600_000 });
            }
          }
        }

        if (ip && isIP(ip) === (question.type === 'A' ? 4 : 6))
          answers.push({
            type: question.type,
            name: question.name,
            class: 'IN',
            ttl: 3600,
            data: ip,
          });
      }

      socket.send(
        encode({
          type: 'response',
          id: query.id,
          flags: (query.flags ?? 0) & RECURSION_DESIRED,
          questions: query.questions,
          answers,
        }),
        peer.port,
        peer.address,
      );
    } catch {
      /* Malformed DNS questions do not terminate the listener. */
    } finally {
      pending--;
    }
  }

  socket.on('message', (bytes, peer) => {
    void handleMessage(bytes, peer);
  });
  let listening = false;
  socket.once('listening', () => {
    listening = true;
  });
  socket.on('error', (error) => {
    if (listening) log.error('network.dns_failed', 'DNS listener failed', { error });
  });
  socket.bind(port, host);

  return {
    socket,
    close: () => {
      resolver.cancel();

      return new Promise<void>((resolve) => socket.close(resolve));
    },
  };
}
