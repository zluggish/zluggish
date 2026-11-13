import { validateConfig } from '#src/config/index';
import { Accounts } from '#src/repositories/accounts.repository';
import { decodeLegacyPacket, encodePacket, FrameDecoder } from '#src/node/network/packet';
import { startRideListeners } from '#src/node/network/ride';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { LoginRequestSchema } from '#src/protocol/generated/login_pb';
import { StreaksSchema } from '#src/protocol/generated/profile_pb';
import {
  ClientToServerSchema,
  PlayerStateSchema,
  ServerToClientSchema,
} from '#src/protocol/generated/udp-node-msgs_pb';
import { worldTime } from '#src/world/state';
import { runtimeFixture } from '#tests/support/runtime';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';

// Port 0 is confined to this test adapter; operator configuration rejects it.
await test(
  'live TCP handshake survives fragmentation and UDP state stays shared with HTTP',
  { timeout: 10_000 },
  async (t) => {
    const f = runtimeFixture(t);
    const user = await f.accounts.create('Socket Rider', 'secret', true);
    const key = Buffer.alloc(16, 7);
    f.world.login(BigInt(user.player_id), key);

    const secret = Buffer.from('pairing-test-secret').toString('base64');

    const registration = await f.app.request('/relay/profiles/me/phone', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ phoneAddress: '127.0.0.2', securePort: 21_588, secret }),
    });

    assert.equal(registration.status, 204);

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
    runtime.config.network.udp.port = udpPort;
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

    assert.equal(handshake.udpConfig?.relayAddresses[0]?.port, udpPort);
    assert.equal(handshake.udpConfigVod1?.port, udpPort);
    assert.ok(
      handshake.udpConfigVod1?.relayAddressesVod.every((group) =>
        group.relayAddresses.every((address) => address.port === udpPort),
      ),
    );
    const [phoneBytes] = await once(socket, 'data');
    const phoneFrame = new FrameDecoder().push(z.instanceof(Buffer).parse(phoneBytes))[0];

    assert.ok(phoneFrame);

    const phone = fromBinary(
      ServerToClientSchema,
      decodeLegacyPacket(phoneFrame, key, {
        device: 1,
        channel: 4,
        connection: 7,
        sequence: 1,
      }).payload.subarray(0, -4),
    );

    assert.equal(phone.zcLocalIp, '127.0.0.2');
    assert.equal(phone.zcLocalPort, 21_588);
    assert.deepEqual(phone.zcKey, Buffer.from(secret, 'base64'));
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
      body: toBinary(LoginRequestSchema, create(LoginRequestSchema, { key })),
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
    endDate: '2026-11-12T10:00:06Z',
    distanceInMeters: 3000,
    totalElevation: 25,
    calories: 50,
    fitFilename: 'synthetic.fit',
    fit: readFileSync(new URL('../fixtures/ride.fit', import.meta.url)),
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
  assert.deepEqual(
    readFileSync(resolve(f.profiles.folder(user.player_id), 'fit', `${id} - synthetic.fit`)),
    Buffer.from(activity.fit),
  );
  const streaks = fromBinary(StreaksSchema, readFileSync(resolve(f.profiles.folder(user.player_id), 'streaks.bin')));
  assert.equal(streaks.curStreakDistance, 3000);
  assert.equal(streaks.curStreakElevation, 25);
  assert.equal(streaks.curStreakCalories, 50);
  assert.equal(
    f.accounts.db.prepare('SELECT power FROM power_curve WHERE player_id=? AND time=?').get(user.player_id, '5')?.power,
    200,
  );
  const detail = await f.app.request(`/api/activities/${id}`, { headers });

  const chartUrl = z.object({ fitnessData: z.object({ fullDataUrl: z.string() }) }).parse(await detail.json())
    .fitnessData.fullDataUrl;

  const chart = await f.app.request(new URL(chartUrl).pathname, { headers });

  const points = z
    .object({ powerInWatts: z.array(z.number()), timeInSec: z.array(z.number()), distanceInCm: z.array(z.number()) })
    .parse(await chart.json());

  assert.deepEqual(points.powerInWatts, [200, 200, 200, 200, 200, 200]);
  assert.deepEqual(points.timeInSec, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(points.distanceInCm, [0, 1000, 2000, 3000, 4000, 5000]);
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
