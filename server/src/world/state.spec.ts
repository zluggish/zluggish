import { Relay, fresh, expired } from '#src/world/state';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { create } from '@bufbuild/protobuf';
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
  assert.equal(relay.udpRead, 42);
  assert.equal(relay.nextUdp(), 0);
  relay.acceptUdp(7, 7);
  assert.equal(relay.udpRead, 43);
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
