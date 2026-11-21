import type { PlayerState, ServerToClient, WorldAttribute } from '#src/protocol/generated/udp-node-msgs_pb';
import { PlayerStateSchema, ServerToClientSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { Lifecycle } from '#src/world/lifecycle';
import type { Simulation } from '#src/world/simulation';
import { StateHistory } from '#src/world/state-history';
import { clone, create, toBinary } from '@bufbuild/protobuf';

/** Zwift world time counts milliseconds from this Unix time. */
export const WORLD_TIME_EPOCH_MS = 1_414_016_075_000;

export function worldTime() {
  return BigInt(Date.now() - WORLD_TIME_EPOCH_MS);
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

/** Durable per-key nonce history. A connection identifier is never reused for TCP. */
export interface RelayHistory {
  tcp: Array<number>;
  udp: Array<[number, number, number]>;
}

export class Relay {
  tcpConnection = 0;

  udpConnection = 0;

  tcpRead = 0;

  tcpWrite = 0;

  udpRead = 0;

  udpWrite = 0;

  private history: RelayHistory = { tcp: [], udp: [] };

  private checkpoint: ((history: RelayHistory) => void) | undefined;

  private failed = false;

  constructor(readonly key: Buffer) {}

  protect(history: RelayHistory, checkpoint: (history: RelayHistory) => void) {
    this.history = history;
    this.checkpoint = checkpoint;
  }

  private save() {
    if (this.failed) {
      throw new Error('Relay persistence failed');
    }
    try {
      this.checkpoint?.(this.history);
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  acceptUdp(connection: number, _explicitConnection?: number, sequence = this.udpRead) {
    const previous = this.history.udp.find(([id]) => id === connection);
    if (previous && sequence <= previous[1]) {
      throw new Error('Replayed UDP packet');
    }
    const entry: [number, number, number] = previous ?? [connection, -1, 0];
    if (!previous) {
      this.history.udp.push(entry);
    }
    entry[1] = sequence;
    this.save();
    this.udpConnection = connection;
    this.udpRead = sequence + 1;
    this.udpWrite = entry[2];
  }

  acceptTcp(connection: number, hello: boolean, sequence = hello ? 0 : this.tcpRead) {
    if (hello) {
      if (sequence !== 0 || this.history.tcp.includes(connection)) {
        throw new Error('Reused TCP connection');
      }
      // Burn the entire TCP connection ID before any reply. After a restart
      // its implicit output counter cannot be reconstructed safely.
      this.history.tcp.push(connection);
      this.save();
      this.tcpConnection = connection;
      this.tcpRead = 1;
      this.tcpWrite = 0;
    } else {
      if (connection !== this.tcpConnection || sequence !== this.tcpRead) {
        throw new Error('Unexpected TCP sequence');
      }
      this.tcpRead++;
    }
  }

  nextUdp() {
    const entry = this.history.udp.find(([id]) => id === this.udpConnection);
    if (!entry || entry[2] > 0xff_ff_ff_ff) {
      throw new Error('UDP nonce space exhausted');
    }
    const sequence = entry[2]++;
    this.save();
    this.udpWrite = entry[2];
    return sequence;
  }

  nextTcp() {
    if (this.failed || this.tcpWrite > 0xff_ff_ff_ff) {
      throw new Error('TCP nonce space exhausted');
    }
    return this.tcpWrite++;
  }
}

/** Encoded size of a `ServerToClient.states` entry (field 8): one tag byte, a varint length, then the state. */
function embeddedSize(length: number) {
  let prefix = 1;

  for (let rest = length; rest >= 0x80; rest >>>= 7) {
    prefix++;
  }

  return 1 + prefix + length;
}

export function fresh(state: PlayerState, now = worldTime()) {
  return now < state.worldTime + 10_000n;
}

export function expired(state: PlayerState, now = worldTime()) {
  return now > state.worldTime + 30_000n;
}

/** Presence is online-map membership plus freshness, independent of relay/socket and observed ride. */
export class World {
  readonly lifecycle = new Lifecycle();

  presence: ((id: bigint, joining: boolean) => void) | undefined;

  disconnect: ((id: bigint) => void) | undefined;

  simulation: Simulation | undefined;

  /** Ride recovery follows each session start and end. */
  sessions: { login: (id: bigint) => void; logout: (id: bigint, reason: string) => void } | undefined;

  readonly personal = new Map<bigint, Map<bigint, PlayerState>>();

  readonly phones = new Map<bigint, ServerToClient>();

  readonly news = new Map<bigint, Map<bigint, bigint>>();

  readonly online = new Map<bigint, PlayerState>();

  readonly relays = new Map<bigint, Relay>();

  readonly updates = new Map<bigint, Array<WorldAttribute>>();

  readonly mapOverrides = new Map<string, string>();

  readonly climbOverrides = new Map<string, string>();

  readonly synthetic = new Map<bigint, PlayerState>();

  readonly histories = new Map<bigint, StateHistory>();

  private readonly generations = new Map<bigint, number>();

  /** Each login and logout starts a new session generation; stale loads compare it. */
  generation(playerId: bigint) {
    return this.generations.get(playerId) ?? 0;
  }

  private advance(playerId: bigint) {
    this.generations.set(playerId, this.generation(playerId) + 1);
  }

  active(playerId: number | bigint) {
    const state = this.online.get(BigInt(playerId));

    return !!state && fresh(state);
  }

  login(playerId: bigint, key: Uint8Array) {
    if (![16, 24, 32].includes(key.length)) {
      throw new Error('Invalid relay key');
    }

    this.disconnect?.(playerId);
    const relay = new Relay(Buffer.from(key));

    this.relays.set(playerId, relay);
    this.histories.delete(playerId);
    this.advance(playerId);
    this.sessions?.login(playerId);

    return relay;
  }

  logout(playerId: bigint, reason = 'logout') {
    this.disconnect?.(playerId);
    this.advance(playerId);
    this.sessions?.logout(playerId, reason);
    this.lifecycle.end(playerId, reason);
    this.simulation?.logout(playerId);
    const wasOnline = this.online.delete(playerId);

    if (wasOnline) {
      this.presence?.(playerId, false);
    }
    this.relays.delete(playerId);
    this.updates.delete(playerId);
    this.news.delete(playerId);
    this.personal.delete(playerId);
    this.phones.delete(playerId);
  }

  receive(playerId: bigint, state: PlayerState) {
    if (state.id && state.id !== playerId) {
      throw new Error('State identity does not match relay');
    }
    const previous = this.online.get(playerId);

    if (previous && previous.worldTime > state.worldTime) {
      return;
    }

    if (!(state.roadTime && (previous || fresh(state)))) {
      return;
    }

    const snapshot = clone(PlayerStateSchema, state);
    snapshot.id = playerId;
    this.online.set(playerId, snapshot);
    this.lifecycle.receive(playerId, snapshot.distance, course(snapshot), BigInt(snapshot.route), snapshot.sport);

    if (!previous) {
      this.presence?.(playerId, true);
    }
    this.simulation?.receive(playerId, snapshot);
    const history = this.histories.get(playerId) ?? new StateHistory();

    if (history.length === 0 || Number(snapshot.worldTime - (history.worldTime(-1) ?? 0n)) >= 3000) {
      history.push(snapshot);
    }

    this.histories.set(playerId, history);
  }

  // Queue admission is bounded; the TCP owner takes/deletes a batch before sending.
  // nearby separately checkpoints each peer timestamp, suppressing unchanged snapshots.
  enqueue(update: WorldAttribute, recipients: Array<bigint> = this.online.keys().toArray()) {
    for (const id of recipients) {
      const queue = this.updates.get(id) ?? [];

      if (queue.length >= 1000) {
        queue.shift();
      }

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
      if (id === playerId || course(watching) !== course(peer)) {
        continue;
      }

      if (this.online.has(id) && !fresh(peer)) {
        continue;
      }

      if (news.get(id) === peer.worldTime) {
        continue;
      }

      const distance = Math.hypot(peer.x - watching.x, peer.z - watching.z, peer.yAltitude - watching.yAltitude);

      if (distance <= 100_000 || road(peer) === road(watching)) {
        candidates.push({ peer, distance });
      }
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

    // Track the encoded size instead of re-encoding the growing packet for each peer.
    let size = toBinary(ServerToClientSchema, message).length;

    for (const peer of this.nearby(playerId, state)) {
      const length = toBinary(PlayerStateSchema, peer).length;

      if (size + length > 1400) {
        packets.push(message);
        message = create(ServerToClientSchema, {
          serverRealm: 1n,
          playerId,
          worldTime: worldTime(),
        });
        size = toBinary(ServerToClientSchema, message).length;
      }

      message.states.push(peer);
      size += embeddedSize(length);
    }

    packets.push(message);

    return packets.map((packet, index) => {
      packet.numMsgs = packets.length;
      packet.msgnum = index + 1;

      return toBinary(ServerToClientSchema, packet);
    });
  }
}
