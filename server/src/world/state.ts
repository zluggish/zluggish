import { create, clone, toBinary } from '@bufbuild/protobuf';
import type { PlayerState, WorldAttribute, ServerToClient } from '#src/protocol/generated/udp-node-msgs_pb';
import { PlayerStateSchema, ServerToClientSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import type { Simulation } from '#src/world/simulation';

export function worldTime() {
  return BigInt(Date.now() - 1_414_016_075_000);
}

export function course(state: PlayerState) {
  return (state.f19 & 0xff_00_00) >>> 16;
}

export function road(state: PlayerState) {
  return (state.aux3 >>> 8) & 0xff_ff;
}

export function forward(state: PlayerState) {
  return (state.f19 & 4) !== 0;
}

export interface Relay {
  key: Buffer;
  tcpConnection: number;
  udpConnection: number;
  tcpRead: number;
  tcpWrite: number;
  udpRead: number;
  udpWrite: number;
}

export class World {
  presence: ((id: bigint, joining: boolean) => void) | undefined;
  simulation: Simulation | undefined;
  readonly personal = new Map<bigint, Map<bigint, PlayerState>>();
  readonly phones = new Map<bigint, ServerToClient>();
  readonly news = new Map<bigint, Map<bigint, bigint>>();
  readonly online = new Map<bigint, PlayerState>();
  readonly relays = new Map<bigint, Relay>();
  readonly updates = new Map<bigint, WorldAttribute[]>();
  readonly mapOverrides = new Map<string, string>();
  readonly climbOverrides = new Map<string, string>();
  readonly synthetic = new Map<bigint, PlayerState>();
  readonly histories = new Map<bigint, PlayerState[]>();

  active(playerId: number | bigint) {
    const state = this.online.get(BigInt(playerId));

    return !!state && worldTime() < state.worldTime + 10_000n;
  }

  login(playerId: bigint, key: Uint8Array) {
    if (![16, 24, 32].includes(key.length)) throw new Error('Invalid relay key');

    const relay: Relay = {
      key: Buffer.from(key),
      tcpConnection: 0,
      udpConnection: 0,
      tcpRead: 0,
      tcpWrite: 0,
      udpRead: 0,
      udpWrite: 0,
    };

    this.relays.set(playerId, relay);
    this.histories.delete(playerId);

    return relay;
  }

  logout(playerId: bigint) {
    this.simulation?.logout(playerId);
    const wasOnline = this.online.delete(playerId);

    if (wasOnline) this.presence?.(playerId, false);
    this.relays.delete(playerId);
    this.updates.delete(playerId);
    this.news.delete(playerId);
    this.personal.delete(playerId);

    if (this.phones.delete(playerId)) console.info(`Companion registration discarded on logout: rider=${playerId}`);
  }

  receive(playerId: bigint, state: PlayerState) {
    if (state.id && state.id !== playerId) throw new Error('State identity does not match relay');
    const previous = this.online.get(playerId);

    if (previous && previous.worldTime > state.worldTime) return;

    if (!(state.roadTime && (previous || worldTime() < state.worldTime + 10_000n))) return;

    const snapshot = clone(PlayerStateSchema, state);
    snapshot.id = playerId;
    this.online.set(playerId, snapshot);

    if (!previous) this.presence?.(playerId, true);
    this.simulation?.receive(playerId, snapshot);
    const history = this.histories.get(playerId) ?? [];

    if (history.length === 0 || Number(snapshot.worldTime - (history.at(-1)?.worldTime ?? 0n)) >= 3000)
      history.push(clone(PlayerStateSchema, snapshot));

    if (history.length > 14_400) history.shift();

    this.histories.set(playerId, history);
  }

  enqueue(update: WorldAttribute, recipients: bigint[] = this.online.keys().toArray()) {
    for (const id of recipients) {
      const queue = this.updates.get(id) ?? [];

      if (queue.length >= 1000) queue.shift();

      queue.push(update);
      this.updates.set(id, queue);
    }
  }

  nearby(playerId: bigint, state: PlayerState) {
    const personal = this.personal.get(playerId) ?? new Map<bigint, PlayerState>();

    const watching =
      this.online.get(state.watchingRiderId) ??
      this.synthetic.get(state.watchingRiderId) ??
      personal.get(state.watchingRiderId) ??
      state;

    const candidates = [];
    const news = this.news.get(playerId) ?? new Map<bigint, bigint>();
    this.news.set(playerId, news);

    for (const [id, peer] of [...this.online, ...this.synthetic, ...personal]) {
      if (id === playerId || course(watching) !== course(peer)) continue;

      if (this.online.has(id) && worldTime() >= peer.worldTime + 10_000n) continue;

      if (news.get(id) === peer.worldTime) continue;

      const distance = Math.hypot(peer.x - watching.x, peer.z - watching.z, peer.yAltitude - watching.yAltitude);

      if (distance <= 100_000 || road(peer) === road(watching)) candidates.push({ peer, distance });
    }

    return candidates
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 100)
      .map((item) => {
        news.set(item.peer.id, item.peer.worldTime);

        return item.peer;
      });
  }

  responses(playerId: bigint, state: PlayerState, clientTime: bigint) {
    const packets = [];

    let message = create(ServerToClientSchema, {
      serverRealm: 1n,
      playerId,
      worldTime: worldTime(),
      ctsLatency: worldTime() - clientTime,
    });

    for (const peer of this.nearby(playerId, state)) {
      if (toBinary(ServerToClientSchema, message).length + toBinary(PlayerStateSchema, peer).length > 1400) {
        packets.push(message);
        message = create(ServerToClientSchema, {
          serverRealm: 1n,
          playerId,
          worldTime: worldTime(),
        });
      }

      message.states.push(peer);
    }

    packets.push(message);

    return packets.map((packet, index) => {
      packet.numMsgs = packets.length;
      packet.msgnum = index + 1;

      return toBinary(ServerToClientSchema, packet);
    });
  }
}
