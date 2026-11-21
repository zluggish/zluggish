import { Relay, World, fresh, expired, worldTime } from '#src/world/state';
import { PlayerStateSchema, ServerToClientSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import type { PlayerState } from '#src/protocol/generated/udp-node-msgs_pb';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('presence and cleanup use different strict protocol-time boundaries', () => {
  const state = create(PlayerStateSchema, { worldTime: 100n });
  assert.equal(fresh(state, 10_099n), true);
  assert.equal(fresh(state, 10_100n), false);
  assert.equal(expired(state, 30_100n), false);
  assert.equal(expired(state, 30_101n), true);
});

await test('relay connection events preserve implicit sequences and reset only on connection changes', () => {
  const relay = new Relay(Buffer.alloc(16));
  relay.acceptUdp(7, 7, 42);
  assert.equal(relay.udpRead, 43);
  assert.equal(relay.nextUdp(), 0);
  relay.acceptUdp(7, 7);
  assert.equal(relay.udpRead, 44);
  assert.equal(relay.nextUdp(), 1);
  relay.acceptUdp(8, 8, 0);
  assert.equal(relay.nextUdp(), 0);
  relay.acceptTcp(8, true);
  assert.equal(relay.tcpRead, 1);
  assert.equal(relay.nextTcp(), 0);
  relay.acceptTcp(8, false);
  assert.equal(relay.tcpRead, 2);
  assert.equal(relay.nextTcp(), 1);
  relay.acceptTcp(9, true);
  assert.equal(relay.tcpRead, 1);
  assert.equal(relay.nextTcp(), 0);
});

await test('relay rejects TCP replay and preserves UDP nonce history across switches and restart', () => {
  const key = Buffer.alloc(16, 7);
  let saved = { tcp: [] as Array<number>, udp: [] as Array<[number, number, number]> };
  const relay = new Relay(key);
  relay.protect(saved, (history) => {
    saved = structuredClone(history);
  });
  relay.acceptTcp(7, true);
  assert.equal(relay.nextTcp(), 0);
  assert.throws(() => relay.acceptTcp(7, true), /Reused/);
  relay.acceptUdp(7, 7, 42);
  assert.equal(relay.nextUdp(), 0);
  assert.throws(() => relay.acceptUdp(7, 7, 42), /Replayed/);
  relay.acceptUdp(8, 8, 0);
  assert.equal(relay.nextUdp(), 0);
  relay.acceptUdp(7, 7, 43);
  assert.equal(relay.nextUdp(), 1);
  const restarted = new Relay(key);
  restarted.protect(saved, () => {});
  assert.throws(() => restarted.acceptTcp(7, true), /Reused/);
  restarted.acceptTcp(8, true);
  assert.equal(restarted.nextTcp(), 0);
  assert.throws(() => restarted.acceptUdp(7, 7, 43), /Replayed/);
  restarted.acceptUdp(7, 7, 44);
  assert.equal(restarted.nextUdp(), 2);
});

await test('relay fails closed after persistence failure and before counter wrap', () => {
  const relay = new Relay(Buffer.alloc(16));
  relay.protect({ tcp: [], udp: [[7, 0, 2 ** 32]] }, () => {});
  relay.acceptUdp(7, 7, 1);
  assert.throws(() => relay.nextUdp(), /exhausted/);
  relay.acceptTcp(7, true);
  relay.tcpWrite = 2 ** 32;
  assert.throws(() => relay.nextTcp(), /exhausted/);
  relay.protect({ tcp: [], udp: [] }, () => {
    throw new Error('disk failed');
  });
  assert.throws(() => relay.acceptTcp(8, true), /disk failed/);
  assert.throws(() => relay.nextTcp(), /exhausted/);
  assert.throws(() => relay.acceptUdp(8, 8, 0), /persistence failed/);
});

await test('responses split nearby riders at the same boundaries as re-encoding each packet', () => {
  const world = new World();
  const now = worldTime();

  const state = (id: bigint, index: number) =>
    create(PlayerStateSchema, {
      id,
      worldTime: now,
      roadTime: 5000,
      f19: (6 << 16) | 4,
      aux3: 10 << 8,
      // Spread values across varint widths so the states differ in encoded size.
      x: index * 997,
      z: index % 3 === 0 ? 2 ** 20 + index : index,
      power: index % 5 === 0 ? 0 : 100 + index * 37,
      heartrate: index % 2 === 0 ? 0 : 120,
      distance: index * 123_457,
    });

  for (let index = 1; index <= 100; index++) {
    world.receive(BigInt(index), state(BigInt(index), index));
  }

  const packets = world.responses(1000n, state(1000n, 0), now).map((bytes) => fromBinary(ServerToClientSchema, bytes));
  const sent = packets.flatMap((packet) => packet.states);
  assert.equal(sent.length, 100);
  assert.ok(packets.length > 2);

  // The former packing: encode the growing packet before adding each state.
  const reference: Array<Array<PlayerState>> = [[]];
  const [first, second] = packets;
  assert.ok(first && second);

  const header = (packet: typeof first, latency: boolean) =>
    create(ServerToClientSchema, {
      serverRealm: packet.serverRealm,
      playerId: packet.playerId,
      worldTime: packet.worldTime,
      ...(latency && { ctsLatency: packet.ctsLatency }),
    });

  let message = header(first, true);

  for (const peer of sent) {
    if (toBinary(ServerToClientSchema, message).length + toBinary(PlayerStateSchema, peer).length > 1400) {
      reference.push([]);
      message = header(second, false);
    }

    message.states.push(peer);
    reference.at(-1)?.push(peer);
  }

  assert.deepEqual(
    packets.map((packet) => packet.states.map((peer) => peer.id)),
    reference.map((group) => group.map((peer) => peer.id)),
  );
  assert.deepEqual(
    packets.map((packet) => [packet.msgnum, packet.numMsgs]),
    packets.map((_, index) => [index + 1, packets.length]),
  );
});
