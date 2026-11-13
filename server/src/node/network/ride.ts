import type { Runtime } from '#src/http/runtime';
import type { InitializationVector } from '#src/node/network/packet';
import { decodePacket, encodePacket, FrameDecoder } from '#src/node/network/packet';
import { ClientToServerSchema, ServerToClientSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { AssetFiles } from '#src/repositories/files.repository';
import { worldTime } from '#src/world/state';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { createSocket } from 'node:dgram';
import { existsSync, readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

export function startRideListeners(runtime: Runtime) {
  const { world, config } = runtime;
  const clients = new Map<string, bigint>();
  const host = config.network.host;

  const udp = createSocket((config.network.udp.host ?? host).includes(':') ? 'udp6' : 'udp4');

  let udpListening = false;
  udp.once('listening', () => {
    udpListening = true;
  });
  udp.on('error', (error) => {
    if (udpListening) world.lifecycle.log.error('network.udp_failed', 'UDP listener failed', { error });
  });
  udp.on('message', (data, address) => {
    try {
      const endpoint = `${address.address}:${address.port}`;
      const flags = data[0] ?? 0;

      const id = clients.get(endpoint) ?? (flags & 4 && data.length >= 5 ? BigInt(data.readUInt32BE(1)) : null);

      if (id === null) return;
      const relay = world.relays.get(id);

      if (!relay) return;

      const iv: InitializationVector = {
        device: 1,
        channel: 1,
        connection: relay.udpConnection,
        sequence: relay.udpRead,
      };

      const decoded = decodePacket(data, relay.key, iv);

      const incoming = fromBinary(ClientToServerSchema, decoded.payload.subarray(1));

      if (incoming.playerId !== id || !incoming.state) return;

      if (decoded.fields.connection !== undefined && decoded.fields.connection !== relay.udpConnection)
        relay.udpWrite = 0;

      clients.set(endpoint, id);
      relay.udpConnection = decoded.iv.connection;
      relay.udpRead = decoded.fields.sequence ?? relay.udpRead + 1;
      world.lifecycle.connected(id);
      world.receive(id, incoming.state);

      for (const payload of world.responses(id, incoming.state, incoming.worldTime)) {
        const sequence = relay.udpWrite++;

        const packet = encodePacket(
          payload,
          relay.key,
          { device: 1, channel: 2, connection: relay.udpConnection, sequence },
          { sequence },
        );

        udp.send(packet, address.port, address.address);
      }
    } catch {
      world.lifecycle.diagnostic('network.udp_rejected', 'Dropped invalid datagram');
      /* Malformed/unordered datagrams must not terminate the ride listener. */
    }
  });
  udp.bind(config.network.udp.port, config.network.udp.host ?? host);

  const sockets = new Set<Socket>();
  const active = new Map<bigint, Socket>();

  const tcp = createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(30_000, () => socket.destroy());
    const framing = new FrameDecoder();
    let playerId: bigint | null = null;
    let timer: NodeJS.Timeout | null = null;

    const send = (payload: Uint8Array) => {
      const relay = playerId === null ? null : world.relays.get(playerId);

      if (!relay || socket.destroyed || playerId === null || active.get(playerId) !== socket) return;

      if (socket.writableLength > 1024 * 1024) {
        socket.destroy();

        return;
      }

      const packet = encodePacket(
        payload,
        relay.key,
        {
          device: 1,
          channel: 4,
          connection: relay.tcpConnection,
          sequence: relay.tcpWrite++,
        },
        {},
      );

      const length = Buffer.alloc(2);
      length.writeUInt16BE(packet.length);
      socket.write(Buffer.concat([length, packet]));
    };

    socket.on('data', (chunk) => {
      try {
        for (const packet of framing.push(chunk)) {
          const first = playerId === null;

          if (playerId !== null && active.get(playerId) !== socket) throw new Error('Superseded relay connection');

          if (playerId === null) {
            if (!((packet[0] ?? 0) & 4) || packet.length < 5) throw new Error('Missing relay identity');

            playerId = BigInt(packet.readUInt32BE(1));
            const id = Number(playerId);

            if (!runtime.accounts.get(id)) throw new Error('Unknown rider');

            const keyPath = resolve(config.storageDir, String(id), 'encryption_key.bin');

            const current = world.relays.get(playerId);

            if (current) new AssetFiles().writeDurable(keyPath, current.key, true);
            else if (existsSync(keyPath)) world.login(playerId, readFileSync(keyPath));
          }

          const relay = playerId === null ? null : world.relays.get(playerId);

          if (!relay) throw new Error('Missing relay key');

          const decoded = decodePacket(packet, relay.key, {
            device: 1,
            channel: 3,
            connection: relay.tcpConnection,
            sequence: first ? 0 : relay.tcpRead,
          });

          const incoming = fromBinary(ClientToServerSchema, decoded.payload.subarray(2));

          if (incoming.playerId !== playerId) throw new Error('Mismatched relay identity');
          world.lifecycle.connected(playerId);
          const hello = first || decoded.fields.connection !== undefined;

          if (hello) {
            const previous = active.get(playerId);

            world.lifecycle.log.verbose('network.tcp_connected', 'Validated relay connection', {
              playerId,
              replaced: !!previous && previous !== socket,
            });

            if (previous && previous !== socket) previous.destroy();
            active.set(playerId, socket);
            relay.tcpConnection = decoded.iv.connection;
            relay.tcpRead = 1;
            relay.tcpWrite = 0;

            const ip =
              socket.remoteAddress === '127.0.0.1' || socket.remoteAddress === '::1'
                ? socket.remoteAddress
                : config.server.advertisedIp;

            const addresses = [
              { lbRealm: 1, lbCourse: 6, ip, port: config.network.udp.port },
              { lbRealm: 0, lbCourse: 0, ip, port: config.network.udp.port },
            ];

            const response = create(ServerToClientSchema, {
              playerId,
              worldTime: 0n,
              udpConfig: {
                relayAddresses: addresses,
                ucF2: 10,
                ucF3: 30,
                ucF4: 3,
              },
              udpConfigVod1: {
                relayAddressesVod: addresses.map((address) => ({
                  lbRealm: address.lbRealm,
                  lbCourse: address.lbCourse,
                  relayAddresses: [address],
                })),
                port: config.network.udp.port,
              },
            });

            send(toBinary(ServerToClientSchema, response));

            if (!timer)
              timer = setInterval(() => {
                if (playerId === null || active.get(playerId) !== socket) return;
                const updates = world.updates.get(playerId) ?? [];
                const phone = world.phones.get(playerId);

                if (phone) {
                  send(toBinary(ServerToClientSchema, phone));
                  world.phones.delete(playerId);
                }

                world.updates.delete(playerId);

                let response = create(ServerToClientSchema, {
                  serverRealm: 1n,
                  playerId,
                  worldTime: worldTime(),
                });

                for (const update of updates) {
                  response.updates.push(update);

                  if (!(toBinary(ServerToClientSchema, response).length >= 1300)) {
                    continue;
                  }

                  send(toBinary(ServerToClientSchema, response));
                  response = create(ServerToClientSchema, {
                    playerId,
                    worldTime: worldTime(),
                  });
                }

                send(toBinary(ServerToClientSchema, response));
              }, 1000);
          } else {
            relay.tcpRead++;

            if (incoming.subsSegments.length > 0)
              send(
                toBinary(
                  ServerToClientSchema,
                  create(ServerToClientSchema, {
                    serverRealm: 1n,
                    playerId,
                    worldTime: worldTime(),
                    ackSubsSegm: incoming.subsSegments,
                  }),
                ),
              );
          }
        }
      } catch {
        world.lifecycle.diagnostic('network.tcp_rejected', 'Closed invalid relay stream');
        socket.destroy();
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      world.lifecycle.log.verbose('network.tcp_closed', 'Relay socket closed', {
        playerId,
        superseded: playerId !== null && active.get(playerId) !== socket,
      });
      sockets.delete(socket);

      if (playerId !== null && active.get(playerId) === socket) active.delete(playerId);

      if (timer) clearInterval(timer);
    });
  });

  tcp.listen(config.network.tcp.port, config.network.tcp.host ?? host);

  const cleanup = setInterval(() => {
    world.lifecycle.prune();

    for (const [id, state] of world.online)
      if (worldTime() > state.worldTime + 30_000n) world.logout(id, 'inactivity_timeout');

    for (const [endpoint, id] of clients) if (!world.relays.has(id)) clients.delete(endpoint);
  }, 5000);

  return {
    tcp,
    udp,
    close: async () => {
      world.lifecycle.close();
      clearInterval(cleanup);

      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve, reject) => tcp.close((error) => (error ? reject(error) : resolve()))),
        new Promise<void>((resolve) => udp.close(resolve)),
      ]);
    },
  };
}
