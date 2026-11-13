import type { Socket } from 'node:net';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { ClientToServerSchema, ServerToClientSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { worldTime } from '#src/world/state';
import { decodeLegacyPacket, encodePacket, FrameDecoder } from '#src/node/network/packet';
import type { InitializationVector } from '#src/node/network/packet';
import type { Runtime } from '#src/http/runtime';
import { writeDurable } from '#src/repositories/files.repository';

export function startRideListeners(runtime: Runtime) {
  const { world, config } = runtime;
  const clients = new Map<string, bigint>();
  const host = config.network.host || '127.0.0.1';

  const udp = createSocket((config.network.udp.host ?? host).includes(':') ? 'udp6' : 'udp4');

  udp.on('error', (error) => console.error('UDP listener:', error.message));
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

      const decoded = decodeLegacyPacket(data, relay.key, iv);

      const incoming = fromBinary(ClientToServerSchema, decoded.payload.subarray(1, -4));

      if (incoming.playerId !== id || !incoming.state) return;

      if (decoded.fields.connection !== undefined && decoded.fields.connection !== relay.udpConnection)
        relay.udpWrite = 0;

      clients.set(endpoint, id);
      relay.udpConnection = decoded.iv.connection;
      relay.udpRead = decoded.fields.sequence ?? relay.udpRead + 1;
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
      /* Malformed/unordered datagrams must not terminate the ride listener. */
    }
  });
  udp.bind(config.network.udp.port, config.network.udp.host ?? host);

  const sockets = new Set<Socket>();

  const tcp = createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(30_000, () => {
      console.warn(`Ride TCP timeout: rider=${playerId ?? 'unknown'}`);
      socket.destroy();
    });
    const framing = new FrameDecoder();
    let playerId: bigint | null = null;
    let timer: NodeJS.Timeout | null = null;
    let phase = 'framing';

    const send = (payload: Uint8Array) => {
      const relay = playerId === null ? null : world.relays.get(playerId);

      if (!relay || socket.destroyed) return false;

      if (socket.writableLength > 1024 * 1024) {
        console.warn(`Ride TCP backpressure limit: rider=${playerId ?? 'unknown'}`);
        socket.destroy();

        return false;
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

      return true;
    };

    socket.on('data', (chunk) => {
      try {
        phase = 'framing';

        for (const packet of framing.push(chunk)) {
          const first = playerId === null;

          if (playerId === null) {
            phase = 'identity';

            if (!((packet[0] ?? 0) & 4) || packet.length < 5) throw new Error('Missing relay identity');

            playerId = BigInt(packet.readUInt32BE(1));
            const id = Number(playerId);

            if (!runtime.accounts.get(id)) throw new Error('Unknown rider');

            const keyPath = resolve(config.storageDir, String(id), 'encryption_key.bin');

            const current = world.relays.get(playerId);

            if (current) writeDurable(keyPath, current.key, true);
            else if (existsSync(keyPath)) world.login(playerId, readFileSync(keyPath));
          }

          const relay = playerId === null ? null : world.relays.get(playerId);

          if (!relay) throw new Error('Missing relay key');

          phase = 'decode';

          const decoded = decodeLegacyPacket(packet, relay.key, {
            device: 1,
            channel: 3,
            connection: relay.tcpConnection,
            sequence: relay.tcpRead,
          });

          phase = 'parse';
          const incoming = fromBinary(ClientToServerSchema, decoded.payload.subarray(2, -4));

          if (incoming.playerId !== playerId) throw new Error('Mismatched relay identity');
          const hello = first || decoded.fields.connection !== undefined;

          if (hello) {
            phase = 'handshake';
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
            console.info(
              `Ride TCP handshake: rider=${playerId} peer=${JSON.stringify(socket.remoteAddress ?? '')} pendingCompanion=${world.phones.has(playerId)}`,
            );

            if (!timer)
              timer = setInterval(() => {
                if (playerId === null) return;
                const updates = world.updates.get(playerId) ?? [];
                const phone = world.phones.get(playerId);

                if (phone) {
                  const sent = send(toBinary(ServerToClientSchema, phone));

                  if (sent) console.info(`Companion registration written to ride TCP: rider=${playerId}`);
                  else console.warn(`Companion registration discarded: ride TCP unavailable for rider=${playerId}`);
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
        console.warn(`Ride TCP processing failed: rider=${playerId ?? 'unknown'} phase=${phase}`);
        socket.destroy();
      }
    });
    socket.on('error', (error) => {
      console.warn(`Ride TCP socket error: rider=${playerId ?? 'unknown'} error=${JSON.stringify(error.message)}`);
    });
    socket.on('close', () => {
      console.info(`Ride TCP closed: rider=${playerId ?? 'unknown'}`);
      sockets.delete(socket);

      if (timer) clearInterval(timer);
    });
  });

  tcp.listen(config.network.tcp.port, config.network.tcp.host ?? host);

  const cleanup = setInterval(() => {
    for (const [id, state] of world.online) if (worldTime() > state.worldTime + 30_000n) world.logout(id);

    for (const [endpoint, id] of clients) if (!world.relays.has(id)) clients.delete(endpoint);
  }, 5000);

  return {
    tcp,
    udp,
    close: () => {
      clearInterval(cleanup);

      for (const socket of sockets) socket.destroy();
      tcp.close();
      udp.close();
    },
  };
}
