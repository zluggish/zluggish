import { create } from '@bufbuild/protobuf';
import type { PlayerState, UserBikeAction } from '#src/protocol/generated/udp-node-msgs_pb';
import { WorldAttributeSchema, WA_TYPE } from '#src/protocol/generated/udp-node-msgs_pb';
import { Random } from '#src/world/geometry';

interface SignallingRider {
  profile: { id: bigint };
  gap: number;
  rate: number;
  dropping: boolean;
  phase: 'approach' | 'pull' | null;
  state: PlayerState | null;
}

export function gestureUpdate(action: UserBikeAction, state: PlayerState, time: bigint) {
  const payload = Buffer.alloc(16);
  payload.writeBigUInt64LE(state.id);
  payload.writeUInt32LE(action, 8);

  return create(WorldAttributeSchema, {
    serverRealm: 1n,
    waType: WA_TYPE.WAT_B_ACT,
    payload,
    x: BigInt(Math.trunc(state.x)),
    yAltitude: BigInt(Math.trunc(state.yAltitude)),
    z: BigInt(Math.trunc(state.z)),
    worldTimeExpire: time + 60_000n,
    importance: 1000,
    waF12: 1n,
    timestamp: BigInt(Date.now()) * 1000n,
  });
}

export class GestureDirector {
  readonly cooldown = new Map<bigint, number>();
  seen = new Map<bigint, { phase: string | null; dropping: boolean; behind: boolean }>();
  readonly surging = new Set<bigint>();
  queue: { expires: number; rider: SignallingRider; action: UserBikeAction }[] = [];
  frontSince: number | null = null;
  nextRandom: number;
  last = 0;
  constructor(
    readonly rng: Random,
    now: number,
    interval: number,
  ) {
    this.nextRandom = now + Math.max(5, interval * rng.between(0.6, 1.4));
  }
  step(now: number, riders: SignallingRider[], interval: number, speed: number, chance: number) {
    const previous = this.seen;
    this.seen = new Map();

    const maybe = (probability: number) => this.rng.value() < Math.min(1, probability * chance);

    const enqueue = (rider: SignallingRider, action: UserBikeAction) => {
      this.queue.push({ expires: now + 6, rider, action });
    };

    const peeling = [];

    for (const rider of riders) {
      const old = previous.get(rider.profile.id) ?? {
        phase: rider.phase,
        dropping: rider.dropping,
        behind: rider.gap > 0,
      };

      this.seen.set(rider.profile.id, {
        phase: rider.phase,
        dropping: rider.dropping,
        behind: rider.gap > 0,
      });

      if (rider.dropping && !old.dropping) peeling.push(rider);

      if (
        (old.phase === 'approach' && rider.phase === 'pull' && maybe(0.35)) ||
        (old.behind && rider.gap < 0 && !rider.phase && maybe(0.2))
      )
        enqueue(rider, 8);

      if (rider.rate >= -0.4 || rider.gap <= 0) this.surging.delete(rider.profile.id);
      else if (!this.surging.has(rider.profile.id) && old.behind && rider.gap >= 4) {
        this.surging.add(rider.profile.id);

        if (maybe(0.5)) enqueue(rider, 4);
      }
    }

    for (const [index, rider] of peeling
      .sort((a, b) => a.gap - b.gap)
      .slice(0, 2)
      .entries()) {
      if (index === 0 && maybe(0.6)) enqueue(rider, 0);
      else if (maybe(0.4)) enqueue(rider, 7);
    }

    if (riders.every((rider) => !(rider.gap < 0))) this.frontSince ??= now;
    else if (this.frontSince !== null) {
      const long = now - this.frontSince >= 40;
      this.frontSince = null;
      const leader = [...riders].sort((a, b) => a.gap - b.gap)[0];

      if (long && leader && maybe(0.6)) enqueue(leader, 5);
    }

    this.queue = this.queue.filter((entry) => entry.expires > now);

    if (speed < 2 || now - this.last < 5) return null;

    const index = this.queue.findIndex((entry) => (this.cooldown.get(entry.rider.profile.id) ?? 0) <= now);

    let selected = index === -1 ? undefined : this.queue.splice(index, 1)[0];

    if (!selected && interval > 0 && now >= this.nextRandom) {
      this.nextRandom = now + Math.max(5, interval * this.rng.between(0.6, 1.4));

      const near = riders.filter(
        (rider) => Math.abs(rider.gap) <= 15 && (this.cooldown.get(rider.profile.id) ?? 0) <= now,
      );

      if (near.length > 0 && maybe(1)) selected = { expires: now + 6, rider: this.rng.pick(near), action: 3 };
    }

    if (!selected?.rider.state) return null;
    this.last = now;
    this.cooldown.set(selected.rider.profile.id, now + 12);

    return { state: selected.rider.state, action: selected.action };
  }
}
