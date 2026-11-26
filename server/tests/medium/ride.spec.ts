import { makeAppRuntime } from '#src/layers';
import { RideCompletionService } from '#src/services/ride-completion.service';
import { JobsService } from '#src/services/jobs.service';
import { DocumentsService } from '#src/services/documents.service';
import { validateConfig } from '#src/config/index';
import { decodePacket, encodePacket, FrameDecoder } from '#src/node/network/packet';
import { startRideListeners } from '#src/node/network/ride';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { LoginRequestSchema } from '#src/protocol/generated/login_pb';
import { StreaksSchema } from '#src/protocol/generated/profile_pb';
import {
  ClientToServerSchema,
  PlayerStateSchema,
  ServerToClientSchema,
  WA_TYPE,
  WorldAttributeSchema,
} from '#src/protocol/generated/udp-node-msgs_pb';
import { AccountsService } from '#src/services/auth.service';
import { Relay, World, worldTime } from '#src/world/state';
import { runtimeFixture } from '#tests/support/runtime';
import { activityFolderOf } from '#tests/medium/support';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { BinaryWriter } from '@bufbuild/protobuf/wire';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Schema } from 'effect';

await test(
  'an authenticated TCP reconnect replaces the old socket and exclusively receives queued updates',
  { timeout: 20_000 },
  async (t) => {
    const f = runtimeFixture(t);
    const user = await f.accounts.create('Reconnect Rider', 'test-password');
    const player = BigInt(user.player_id);
    const key = Buffer.alloc(16, 8);
    f.world.login(player, key);

    const runtime = {
      ...f,
      config: {
        ...f.config,
        network: {
          ...f.config.network,
          host: '127.0.0.1',
          tcp: { ...f.config.network.tcp, port: 0 },
          udp: { ...f.config.network.udp, port: 0 },
        },
      },
    };
    let listeners = startRideListeners(runtime);

    t.after(() => listeners.close());

    if (!listeners.tcp.listening) {
      await once(listeners.tcp, 'listening');
    }
    let { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }))(listeners.tcp.address());

    const connect = async (connection: number) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      t.after(() => socket.destroy());
      await once(socket, 'connect');
      const incoming = socket.iterator();
      const framing = new FrameDecoder();
      const queue: Array<Buffer> = [];
      let sequence = 0;

      const next = async () => {
        while (queue.length === 0) {
          const chunk = await incoming.next();
          assert.equal(chunk.done, false);
          queue.push(...framing.push(Schema.decodeUnknownSync(Schema.instanceOf(Buffer))(chunk.value)));
        }

        const frame = queue.shift();
        assert.ok(frame);

        return fromBinary(
          ServerToClientSchema,
          decodePacket(frame, key, { device: 1, channel: 4, connection, sequence: sequence++ }).payload,
        );
      };

      const payload = toBinary(
        ClientToServerSchema,
        create(ClientToServerSchema, {
          serverRealm: 1n,
          playerId: player,
          state: create(PlayerStateSchema),
          lastUpdate: 0n,
          lastPlayerUpdate: 0n,
        }),
      );

      const hello = encodePacket(
        Buffer.concat([Buffer.from([1, 0]), payload]),
        key,
        { device: 1, channel: 3, connection, sequence: 0 },
        { relay: user.player_id, connection },
      );

      const length = Buffer.alloc(2);
      length.writeUInt16BE(hello.length);
      socket.write(Buffer.concat([length, hello]));
      const handshake = await next();
      assert.ok(handshake.udpConfig);

      const subscribe = () => {
        const body = toBinary(
          ClientToServerSchema,
          create(ClientToServerSchema, {
            serverRealm: 1n,
            playerId: player,
            state: create(PlayerStateSchema),
            lastUpdate: 0n,
            lastPlayerUpdate: 0n,
            subsSegments: [123n],
          }),
        );
        const packet = encodePacket(
          Buffer.concat([Buffer.from([1, 0]), body]),
          key,
          { device: 1, channel: 3, connection, sequence: 1 },
          { connection, sequence: 1 },
        );
        const size = Buffer.alloc(2);
        size.writeUInt16BE(packet.length);
        socket.write(Buffer.concat([size, packet]));
      };
      return { socket, next, subscribe, captured: Buffer.concat([length, hello]) };
    };

    const old = await connect(7);
    old.subscribe();
    let acknowledgment = await old.next();
    while (acknowledgment.ackSubsSegm.length === 0) {
      acknowledgment = await old.next();
    }
    assert.deepEqual(acknowledgment.ackSubsSegm, [123n]);
    const rejectReplay = async (captured: Buffer) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      t.after(() => socket.destroy());
      await once(socket, 'connect');
      const closed = once(socket, 'close');
      let replies = 0;
      socket.on('data', () => replies++);
      socket.write(captured);
      await closed;
      assert.equal(replies, 0);
    };
    await rejectReplay(old.captured);
    assert.equal(old.socket.destroyed, false);
    const closed = once(old.socket, 'close');
    const replacement = await connect(8);
    await closed;
    // Internal producers bypass HTTP validation; a single update must still
    // never overflow the length prefix or consume the receiver's next sequence.
    f.world.enqueue(create(WorldAttributeSchema, { payload: Buffer.from('before oversized') }), [player]);
    f.world.enqueue(create(WorldAttributeSchema, { payload: Buffer.alloc(65_536) }), [player]);
    f.world.enqueue(
      create(WorldAttributeSchema, {
        serverRealm: 1n,
        waType: WA_TYPE.WAT_INV_W,
        payload: Buffer.from('replacement only'),
      }),
      [player],
    );
    const beforeOversized = await replacement.next();
    assert.equal(Buffer.from(beforeOversized.updates[0]!.payload).toString(), 'before oversized');
    const update = await replacement.next();
    assert.equal(update.updates.length, 1);
    assert.equal(Buffer.from(update.updates[0]!.payload).toString(), 'replacement only');
    assert.equal(f.world.updates.has(player), false);
    // Closing the superseded socket must not remove ownership of the replacement.
    const heartbeat = await replacement.next();
    assert.equal(heartbeat.playerId, player);

    // Exercise the exact encrypted frame boundary, including its five bytes
    // of header/tag overhead. The next oversized phone message is dropped.
    const phone = create(ServerToClientSchema, { zcKey: Buffer.alloc(65_520) });
    phone.zcKey = Buffer.alloc(phone.zcKey.length + 65_530 - toBinary(ServerToClientSchema, phone).length);
    assert.equal(toBinary(ServerToClientSchema, phone).length, 65_530);
    f.world.phones.set(player, phone);
    const boundaryPhone = await replacement.next();
    assert.equal(boundaryPhone.zcKey.length, phone.zcKey.length);
    await replacement.next(); // Tick heartbeat after the phone.
    phone.zcKey = Buffer.alloc(phone.zcKey.length + 1);
    f.world.phones.set(player, phone);
    const afterOversizedPhone = await replacement.next();
    assert.equal(afterOversizedPhone.zcKey.length, 0);

    // Exceptions raised on a timer tick must close only this stream.
    const relay = f.world.relays.get(player)!;
    const nextTcp = relay.nextTcp;
    relay.nextTcp = () => {
      throw new Error('Injected send failure');
    };
    const failed = once(replacement.socket, 'close');
    replacement.socket.resume();
    await failed;
    relay.nextTcp = nextTcp;
    const recovered = await connect(9);
    const recoveredHeartbeat = await recovered.next();
    assert.equal(recoveredHeartbeat.playerId, player);

    await listeners.close();
    f.world.relays.clear();
    listeners = startRideListeners(runtime);
    if (!listeners.tcp.listening) {
      await once(listeners.tcp, 'listening');
    }
    port = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }))(listeners.tcp.address()).port;
    await rejectReplay(old.captured);
    await rejectReplay(replacement.captured);
    const restarted = await connect(10);
    const restartedHeartbeat = await restarted.next();
    assert.equal(restartedHeartbeat.playerId, player);
  },
);

await test('world attribute ingress bounds raw and rewritten updates while preserving ordinary updates', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Attribute Rider', 'test-password');
  const player = BigInt(user.player_id);
  f.world.login(player, Buffer.alloc(16, 1));
  f.world.online.set(player, create(PlayerStateSchema));
  const post = (payload: Uint8Array) =>
    f.app.request('/relay/worlds/attributes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}` },
      body: toBinary(WorldAttributeSchema, create(WorldAttributeSchema, { payload })),
    });

  const oversized = await post(Buffer.alloc(65_536));
  assert.equal(oversized.status, 413);
  assert.equal(f.world.updates.has(player), false);
  // Fits the raw limit, but the server's timestamp/expiry fields push it over.
  const rewrittenOversized = await post(Buffer.alloc(60 * 1024 - 4));
  assert.equal(rewrittenOversized.status, 413);
  assert.equal(f.world.updates.has(player), false);
  const ordinary = await post(Buffer.from('ordinary update'));
  assert.equal(ordinary.status, 201);
  assert.equal(Buffer.from(f.world.updates.get(player)![0]!.payload).toString(), 'ordinary update');
});

await test('nonce history survives database reopen, key changes and service restart; legacy recovery fails closed', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Durable Relay', 'test-password');
  const id = user.player_id;
  f.accounts.db.exec('PRAGMA synchronous=NORMAL');
  const key = Buffer.alloc(16, 15);
  const relay = new Relay(key);
  f.effects.runSync(RideCompletionService.use((service) => service.protectRelay(id, relay, true)));
  relay.acceptTcp(7, true);
  relay.nextTcp();
  relay.acceptUdp(9, 9, 19);
  relay.nextUdp();
  assert.equal(f.accounts.db.prepare('PRAGMA synchronous').get()?.synchronous, 1);
  const reopened = AccountsService.open(f.accounts.storage);
  const effects = makeAppRuntime({ ...f, accounts: reopened, world: new World() });
  try {
    const restored = new Relay(key);
    effects.runSync(RideCompletionService.use((service) => service.protectRelay(id, restored)));
    assert.throws(() => restored.acceptTcp(7, true), /Reused/);
    restored.acceptTcp(8, true);
    assert.equal(restored.nextTcp(), 0);
    assert.throws(() => restored.acceptUdp(9, 9, 19), /Replayed/);
    restored.acceptUdp(9, 9, 20);
    assert.equal(restored.nextUdp(), 1);
    const newKey = new Relay(Buffer.alloc(16, 16));
    effects.runSync(RideCompletionService.use((service) => service.protectRelay(id, newKey, true)));
    newKey.acceptTcp(7, true);
    const reusedKey = new Relay(key);
    effects.runSync(RideCompletionService.use((service) => service.protectRelay(id, reusedKey, true)));
    assert.throws(() => reusedKey.acceptTcp(7, true), /Reused/);
    const legacy = Buffer.alloc(16, 17);
    reopened.repositories.riderDocuments.put(id, 'encryption_key.bin', legacy);
    assert.throws(
      () => effects.runSync(RideCompletionService.use((service) => service.protectRelay(id, new Relay(legacy)))),
      /nonce history unavailable/,
    );
    assert.throws(
      () => effects.runSync(RideCompletionService.use((service) => service.protectRelay(id, new Relay(legacy), true))),
      /nonce history unavailable/,
    );
  } finally {
    await effects.dispose();
    reopened.close();
  }
});

// Port 0 is confined to this test adapter; operator configuration rejects it.
await test(
  'live relay pairs Companion, replies to stateless UDP messages and shares subsequent riding state with HTTP',
  { timeout: 10_000 },
  async (t) => {
    const f = runtimeFixture(t);
    const user = await f.accounts.create('Socket Rider', 'secret');
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

    if (!listeners.tcp.listening) {
      await once(listeners.tcp, 'listening');
    }
    // UDP bind is asynchronous; TCP listen notification does not imply UDP readiness.
    let udpAddress;

    try {
      udpAddress = listeners.udp.address();
    } catch {
      await once(listeners.udp, 'listening');
      udpAddress = listeners.udp.address();
    }

    const tcpPort = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }))(listeners.tcp.address()).port;

    const udpPort = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }))(udpAddress).port;
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
    const frames = new FrameDecoder().push(Schema.decodeUnknownSync(Schema.instanceOf(Buffer))(bytes));
    const first = frames[0];
    assert.ok(first);

    const decoded = decodePacket(first, key, {
      device: 1,
      channel: 4,
      connection: 7,
      sequence: 0,
    });

    const handshake = fromBinary(ServerToClientSchema, decoded.payload);

    assert.equal(handshake.udpConfig?.relayAddresses[0]?.port, udpPort);
    assert.equal(handshake.udpConfigVod1?.port, udpPort);
    assert.ok(
      handshake.udpConfigVod1?.relayAddressesVod.every((group) =>
        group.relayAddresses.every((address) => address.port === udpPort),
      ),
    );
    const [phoneBytes] = await once(socket, 'data');
    const phoneFrame = new FrameDecoder().push(Schema.decodeUnknownSync(Schema.instanceOf(Buffer))(phoneBytes))[0];

    assert.ok(phoneFrame);

    const phone = fromBinary(
      ServerToClientSchema,
      decodePacket(phoneFrame, key, {
        device: 1,
        channel: 4,
        connection: 7,
        sequence: 1,
      }).payload,
    );

    assert.equal(phone.zcLocalIp, '127.0.0.2');
    assert.equal(phone.zcLocalPort, 21_588);
    assert.deepEqual(phone.zcKey, Buffer.from(secret, 'base64'));
    assert.ok(f.effects.runSync(DocumentsService.use((service) => service.has(user.player_id, 'encryption_key.bin'))));
    const udp = createSocket('udp4');
    t.after(() => udp.close());

    // Python protobuf exposes an empty state when this field is absent. The
    // TypeScript decoder leaves it undefined; these messages still need replies.
    // Write the wire fields directly: toBinary enforces required state, whereas
    // real clients can omit it and fromBinary accepts its absence.
    const probe = new BinaryWriter()
      .uint32(8)
      .int64(1n)
      .uint32(16)
      .int64(BigInt(user.player_id))
      .uint32(80)
      .int64(0n)
      .uint32(96)
      .int64(0n)
      .finish();

    assert.equal(fromBinary(ClientToServerSchema, probe).state, undefined);

    for (const sequence of [19, 20]) {
      const packet = encodePacket(
        Buffer.concat([Buffer.from([1]), probe]),
        key,
        { device: 1, channel: 1, connection: 9, sequence },
        sequence === 19 ? { relay: user.player_id, connection: 9, sequence } : { sequence },
      );

      if (sequence === 19) {
        assert.equal(packet.length, 24);
      }
      const incoming = once(udp, 'message');
      udp.send(packet, udpPort, '127.0.0.1');
      const [reply] = await incoming;

      const decoded = decodePacket(Schema.decodeUnknownSync(Schema.instanceOf(Buffer))(reply), key, {
        device: 1,
        channel: 2,
        connection: 9,
        sequence: sequence - 19,
      });

      assert.equal(decoded.fields.sequence, sequence - 19);
      const response = fromBinary(ServerToClientSchema, decoded.payload);
      assert.equal(response.playerId, BigInt(user.player_id));
      assert.equal(response.serverRealm, 1n);
      assert.equal(response.numMsgs, 1);
      assert.equal(response.msgnum, 1);
      assert.deepEqual(response.states, []);
      assert.equal(f.world.active(user.player_id), false);
      assert.equal(f.world.online.size, 0);
      assert.equal(f.world.histories.size, 0);
      assert.equal(f.world.lifecycle.rides.size, 0);
      // Queue a captured packet before the next valid request. It must produce
      // no response or counter change; the next response still has sequence 1.
      if (sequence === 19) {
        udp.send(packet, udpPort, '127.0.0.1');
      }
    }

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
      { device: 1, channel: 1, connection: 9, sequence: 21 },
      { sequence: 21 },
    );

    const incoming = once(udp, 'message');
    udp.send(datagram, udpPort, '127.0.0.1');
    const [reply] = await incoming;

    const body = decodePacket(Schema.decodeUnknownSync(Schema.instanceOf(Buffer))(reply), key, {
      device: 1,
      channel: 2,
      connection: 9,
      sequence: 2,
    }).payload;

    assert.equal(fromBinary(ServerToClientSchema, body).playerId, BigInt(user.player_id));
    // Exercise implicit input sequences and return to an earlier UDP connection.
    // Each connection retains its own output sequence instead of restarting it.
    for (const [connection, sequence, expected, implicit] of [
      [9, 22, 3, true],
      [10, 0, 0, false],
      [9, 23, 4, false],
    ] as const) {
      const next = once(udp, 'message');
      udp.send(
        encodePacket(
          Buffer.concat([Buffer.from([1]), payload]),
          key,
          { device: 1, channel: 1, connection, sequence },
          implicit ? {} : { connection, sequence },
        ),
        udpPort,
        '127.0.0.1',
      );
      const [bytes] = await next;
      const decoded = decodePacket(Schema.decodeUnknownSync(Schema.instanceOf(Buffer))(bytes), key, {
        device: 1,
        channel: 2,
        connection,
        sequence: expected,
      });
      assert.equal(decoded.fields.sequence, expected);
      assert.equal(fromBinary(ServerToClientSchema, decoded.payload).playerId, BigInt(user.player_id));
    }

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
  const user = await f.accounts.create('Saving Rider', 'test-password');
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
  const id = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(await response.json()).id;

  const finished = await f.app.request(`/api/profiles/${user.player_id}/activities/${id}?upload-to-strava=true`, {
    method: 'PUT',
    headers,
    body: toBinary(ActivitySchema, activity),
  });

  assert.equal(finished.status, 200);
  // The FIT export and the chart are jobs after the completion commit.
  const pending = await f.app.request(`/api/activities/${id}`, { headers });
  assert.equal(
    'fitnessData' in Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(await pending.json()),
    false,
  );
  await f.effects.runPromise(JobsService.use((service) => service.drain()));
  assert.deepEqual(readFileSync(resolve(activityFolderOf(f, id), 'activity.fit')), Buffer.from(activity.fit));

  const streaks = fromBinary(
    StreaksSchema,
    f.effects.runSync(DocumentsService.use((service) => service.get(user.player_id, 'streaks.bin'))) ??
      new Uint8Array(),
  );

  assert.equal(streaks.curStreakDistance, 3000);
  assert.equal(streaks.curStreakElevation, 25);
  assert.equal(streaks.curStreakCalories, 50);
  assert.equal(
    f.accounts.db.prepare('SELECT power FROM power_curve WHERE player_id=? AND time=?').get(user.player_id, '5')?.power,
    200,
  );
  const detail = await f.app.request(`/api/activities/${id}`, { headers });

  const chartUrl = Schema.decodeUnknownSync(
    Schema.Struct({ fitnessData: Schema.Struct({ fullDataUrl: Schema.String }) }),
  )(await detail.json()).fitnessData.fullDataUrl;

  const chart = await f.app.request(new URL(chartUrl).pathname, { headers });

  const points = Schema.decodeUnknownSync(
    Schema.Struct({
      powerInWatts: Schema.Array(Schema.Finite),
      timeInSec: Schema.Array(Schema.Finite),
      distanceInCm: Schema.Array(Schema.Finite),
    }),
  )(await chart.json());

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
  const reopened = AccountsService.open(f.accounts.storage);

  try {
    assert.equal(reopened.db.prepare('SELECT name FROM activity WHERE id=?').get(id)?.name, 'Synthetic ride');
  } finally {
    reopened.close();
  }
});
