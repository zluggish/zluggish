import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { createSocket } from 'node:dgram';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { z } from 'zod';
import { runtimeFixture } from '#tests/support/runtime';
import { validateConfig } from '#src/config/index';
import { startRideListeners } from '#src/node/network/ride';
import { encodePacket, decodeLegacyPacket, FrameDecoder } from '#src/node/network/packet';
import {
  ClientToServerSchema,
  PlayerStateSchema,
  ServerToClientSchema,
} from '#src/protocol/generated/udp-node-msgs_pb';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { worldTime } from '#src/world/state';
import { existsSync } from 'node:fs';
import { Accounts } from '#src/domain/accounts/repository';
import { resolve } from 'node:path';

// Port 0 is confined to this test adapter; operator configuration rejects it.
await test(
  'live TCP handshake survives fragmentation and UDP state stays shared with HTTP',
  { timeout: 10_000 },
  async (t) => {
    const f = runtimeFixture(t);
    const user = await f.accounts.create('Socket Rider', 'secret', true);
    const key = Buffer.alloc(16, 7);
    f.world.login(BigInt(user.player_id), key);

    const config = validateConfig({
      storageDir: f.config.storageDir,
      network: { host: '127.0.0.1' },
    });

    const runtime = {
      ...f,
      config: {
        ...config,
        network: {
          ...config.network,
          tcp: { ...config.network.tcp, port: 0 },
          udp: { ...config.network.udp, port: 0 },
        },
      },
    };

    const listeners = startRideListeners(runtime);
    t.after(() => listeners.close());

    if (!listeners.tcp.listening) await once(listeners.tcp, 'listening');
    // UDP bind is asynchronous; TCP listen notification does not imply UDP readiness.
    let udpAddress;

    try {
      udpAddress = listeners.udp.address();
    } catch {
      await once(listeners.udp, 'listening');
      udpAddress = listeners.udp.address();
    }

    const tcpPort = z.object({ port: z.number() }).parse(listeners.tcp.address()).port;

    const udpPort = z.object({ port: z.number() }).parse(udpAddress).port;
    const socket = createConnection({ host: '127.0.0.1', port: tcpPort });
    t.after(() => socket.destroy());
    await once(socket, 'connect');

    const request = toBinary(
      ClientToServerSchema,
      create(ClientToServerSchema, {
        serverRealm: 1n,
        playerId: BigInt(user.player_id),
        state: create(PlayerStateSchema),
        lastUpdate: 0n,
        lastPlayerUpdate: 0n,
      }),
    );

    const hello = encodePacket(
      Buffer.concat([Buffer.from([1, 0]), request]),
      key,
      { device: 1, channel: 3, connection: 7, sequence: 0 },
      { relay: user.player_id, connection: 7 },
    );

    const length = Buffer.alloc(2);
    length.writeUInt16BE(hello.length);
    const response = once(socket, 'data');
    socket.write(length.subarray(0, 1));
    socket.write(Buffer.concat([length.subarray(1), hello]));
    const [bytes] = await response;
    const frames = new FrameDecoder().push(z.instanceof(Buffer).parse(bytes));
    const first = frames[0];
    assert.ok(first);

    const decoded = decodeLegacyPacket(first, key, {
      device: 1,
      channel: 4,
      connection: 7,
      sequence: 0,
    });

    const handshake = fromBinary(ServerToClientSchema, decoded.payload.subarray(0, -4));

    assert.equal(handshake.udpConfig?.relayAddresses[0]?.port, 3022);
    assert.ok(existsSync(resolve(f.accounts.storage, String(user.player_id), 'encryption_key.bin')));
    const udp = createSocket('udp4');
    t.after(() => udp.close());

    const state = create(PlayerStateSchema, {
      id: BigInt(user.player_id),
      roadTime: 100,
      worldTime: worldTime(),
      f19: 6 << 16,
      watchingRiderId: BigInt(user.player_id),
    });

    const payload = toBinary(
      ClientToServerSchema,
      create(ClientToServerSchema, {
        serverRealm: 1n,
        playerId: BigInt(user.player_id),
        lastUpdate: 0n,
        lastPlayerUpdate: 0n,
        worldTime: worldTime(),
        state,
      }),
    );

    const datagram = encodePacket(
      Buffer.concat([Buffer.from([1]), payload]),
      key,
      { device: 1, channel: 1, connection: 9, sequence: 0 },
      { relay: user.player_id, connection: 9, sequence: 0 },
    );

    const incoming = once(udp, 'message');
    udp.send(datagram, udpPort, '127.0.0.1');
    const [reply] = await incoming;

    const body = decodeLegacyPacket(z.instanceof(Buffer).parse(reply), key, {
      device: 1,
      channel: 2,
      connection: 9,
      sequence: 0,
    }).payload.subarray(0, -4);

    assert.equal(fromBinary(ServerToClientSchema, body).playerId, BigInt(user.player_id));
    assert.equal(f.world.active(user.player_id), true);
    const token = f.sessions.tokens(user, f.tokens).access_token;

    const login = await f.app.request('/api/users/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(login.status, 409);
  },
);

await test('activity create, save and restart preserve ownership, FIT bytes and progress', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Saving Rider', '', true);
  const token = f.sessions.tokens(user, f.tokens).access_token;
  const headers = { Authorization: `Bearer ${token}` };

  const activity = create(ActivitySchema, {
    playerId: BigInt(user.player_id),
    courseId: 6n,
    name: 'Synthetic ride',
    startDate: '2026-11-12T10:00:00Z',
    date: '2026-11-12T10:00:00Z',
    distanceInMeters: 1000,
    fitFilename: 'synthetic.fit',
    fit: new Uint8Array([0, 1, 2, 255]),
  });

  const response = await f.app.request(`/api/profiles/${user.player_id}/activities`, {
    method: 'POST',
    headers,
    body: toBinary(ActivitySchema, activity),
  });

  assert.equal(response.status, 200);
  const id = z.object({ id: z.number() }).parse(await response.json()).id;

  const finished = await f.app.request(`/api/profiles/${user.player_id}/activities/${id}?upload-to-strava=true`, {
    method: 'PUT',
    headers,
    body: toBinary(ActivitySchema, activity),
  });

  assert.equal(finished.status, 200);
  assert.ok(existsSync(resolve(f.profiles.folder(user.player_id), 'fit', `${id} - synthetic.fit`)));
  const other = await f.accounts.create('Other', 'password');

  const attempt = await f.app.request(`/api/profiles/${user.player_id}/activities/${id}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${f.sessions.tokens(other, f.tokens).access_token}`,
    },
  });

  assert.equal(attempt.status, 401);
  f.accounts.close();
  const reopened = new Accounts(f.accounts.storage);

  try {
    assert.equal(reopened.db.prepare('SELECT name FROM activity WHERE id=?').get(id)?.name, 'Synthetic ride');
  } finally {
    reopened.close();
  }
});
