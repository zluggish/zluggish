import type { PlayerState } from '#src/protocol/generated/udp-node-msgs_pb';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { course, forward, road } from '#src/world/state';
import { clone } from '@bufbuild/protobuf';

export const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export const lerp = (a: number, b: number, fraction: number) => a + (b - a) * fraction;

export const continuous = (a: PlayerState, b: PlayerState) =>
  course(a) === course(b) &&
  road(a) === road(b) &&
  forward(a) === forward(b) &&
  Math.abs(a.roadTime - b.roadTime) < 50_000;

export function interpolate(a: PlayerState, b: PlayerState, fraction: number) {
  const state = clone(PlayerStateSchema, fraction < 0.5 ? a : b);

  if (!continuous(a, b)) return state;
  state.roadTime = Math.round(lerp(a.roadTime, b.roadTime, fraction));
  state.roadPosition = Math.round(lerp(a.roadPosition, b.roadPosition, fraction));
  state.x = lerp(a.x, b.x, fraction);
  state.z = lerp(a.z, b.z, fraction);
  state.yAltitude = lerp(a.yAltitude, b.yAltitude, fraction);
  state.speed = Math.round(lerp(a.speed, b.speed, fraction));
  state.power = Math.round(lerp(a.power, b.power, fraction));

  if (b.distance >= a.distance && b.distance - a.distance < 1000)
    state.distance = Math.round(lerp(a.distance, b.distance, fraction));
  const headingDelta = b.heading - a.heading;

  if (headingDelta > -1_000_000n && headingDelta < 1_000_000n)
    state.heading = a.heading + BigInt(Math.round(Number(headingDelta) * fraction));

  return state;
}

export class Random {
  constructor(private seed = Math.floor(Math.random() * 0xff_ff_ff_ff)) {
    this.seed ||= 1;
  }
  value() {
    let value = this.seed;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.seed = value;

    return (value >>> 0) / 4_294_967_296;
  }
  between(low: number, high: number) {
    return lerp(low, high, this.value());
  }
  gaussian(sigma = 1) {
    return (
      Math.sqrt(-2 * Math.log(Math.max(this.value(), Number.EPSILON))) * Math.cos(2 * Math.PI * this.value()) * sigma
    );
  }
  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.value() * items.length)];

    if (item === undefined) throw new Error('Empty random pool');

    return item;
  }
  shuffle<T>(items: readonly T[]) {
    const shuffled = [...items];

    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(this.value() * (i + 1));
      const a = shuffled[i];
      const b = shuffled[j];

      if (a === undefined || b === undefined) {
        continue;
      }

      shuffled[i] = b;
      shuffled[j] = a;
    }

    return shuffled;
  }
}

interface Snapshot {
  state: PlayerState;
  time: number;
  lag: number | null;
  distance: number;
  sign: number;
}

export interface Sample {
  state: PlayerState;
  hx: number;
  hz: number;
  sign: number;
}

/** Recent road geometry measured in metres. A road/lap boundary never interpolates road coordinates. */
export class Trail {
  entries: Snapshot[] = [];
  resets = 0;
  latency = 0;
  heading: [number, number] = [0, 0];
  constructor(readonly now: () => number = () => performance.now() / 1000) {}
  push(state: PlayerState, lag: number | null = null) {
    let last = this.entries.at(-1);

    const distance = last ? Math.hypot(state.x - last.state.x, state.z - last.state.z) / 100 : 0;

    if (
      last &&
      ((state.roadTime + 60_000 < last.state.roadTime && distance > 40) ||
        distance > 150 ||
        course(state) !== course(last.state))
    ) {
      this.entries = [];
      this.resets++;
      last = undefined;
    }

    const snap: Snapshot = {
      state: clone(PlayerStateSchema, state),
      time: this.now(),
      lag,
      distance: (last?.distance ?? 0) + distance,
      sign: last?.sign ?? 1,
    };

    if (!last) {
      snap.distance = 0;
      this.entries.push(snap);

      return;
    }

    if (
      road(state) === road(last.state) &&
      Math.abs(state.roadTime - last.state.roadTime) < 60_000 &&
      state.roadTime !== last.state.roadTime
    )
      snap.sign = state.roadTime > last.state.roadTime ? 1 : -1;

    if (distance < 0.2) {
      if (state.roadTime >= last.state.roadTime) {
        snap.distance = last.distance;
        this.entries[this.entries.length - 1] = snap;
      }

      return;
    }

    this.entries.push(snap);

    while (this.entries.length > 3 && (this.entries[1]?.distance ?? 0) < snap.distance - 90) this.entries.shift();
  }
  // collecting -> ready with >3.2m across >=2 samples; >=8s age is stale.
  // push detects course/teleport discontinuity, clears history and increments generation.
  ready() {
    const head = this.entries.at(-1);

    return (
      !!head &&
      this.entries.length >= 2 &&
      head.distance - (this.entries[0]?.distance ?? 0) > 3.2 &&
      this.now() - head.time < 8
    );
  }
  acceleration() {
    const head = this.entries.at(-1);

    if (!head || this.entries.length < 3) return 0;
    let ref: Snapshot | undefined;

    for (let index = this.entries.length - 2; index >= 0; index--) {
      const entry = this.entries[index];

      if (!entry || head.time - entry.time > 6) break;
      ref = entry;

      if (head.time - entry.time >= 2.5) break;
    }

    return ref && head.time - ref.time >= 1
      ? clamp((head.state.speed - ref.state.speed) / 3_600_000 / (head.time - ref.time), -3, 3)
      : 0;
  }
  motion() {
    const head = this.entries.at(-1);

    if (!head) return { speed: 0, acceleration: 0, advance: 0 };
    const age = clamp(this.now() - head.time + this.latency, 0, 8);
    const original = head.state.speed / 3_600_000;
    const acceleration = this.acceleration();
    let horizon = Math.min(age, 2.5);

    if (acceleration < 0) horizon = Math.min(horizon, original / -acceleration);
    const speed = Math.max(0, original + acceleration * horizon);

    return {
      speed,
      acceleration,
      advance: clamp(original * horizon + 0.5 * acceleration * horizon * horizon + speed * (age - horizon), 0, 30),
    };
  }
  grade() {
    const head = this.entries.at(-1);

    if (!head || this.entries.length < 3) return 0;
    let ref = this.entries[0];

    for (let index = this.entries.length - 2; index >= 0; index--) {
      const entry = this.entries[index];

      if (entry) ref = entry;

      if (ref && head.distance - ref.distance >= 25) break;
    }

    if (!ref || head.distance - ref.distance < 8) return 0;

    return clamp((head.state.yAltitude - ref.state.yAltitude) / 100 / (head.distance - ref.distance), -0.25, 0.25);
  }
  sample(gap: number): Sample | null {
    const head = this.entries.at(-1);

    if (!head) return null;
    const previous = this.entries.at(-2) ?? head;
    const offset = this.motion().advance - gap;

    if (offset >= 0) {
      const state = clone(PlayerStateSchema, head.state);
      const vx = head.state.x - previous.state.x;
      const vz = head.state.z - previous.state.z;
      const length = Math.hypot(vx, vz);

      if (length < 1)
        return {
          state,
          hx: this.heading[0],
          hz: this.heading[1],
          sign: head.sign,
        };
      let hx = vx / length;
      let hz = vz / length;
      const lead = Math.min(offset, 42);
      let base: Snapshot | undefined;

      for (let index = this.entries.length - 2; index >= 0; index--) {
        const entry = this.entries[index];

        if (!entry || road(entry.state) !== road(head.state)) break;
        base = entry;

        if (head.distance - entry.distance >= 3) break;
      }

      const span = base ? head.distance - base.distance : 0;
      let curvature = 0;
      const before = this.entries.at(-3);

      if (before) {
        const ax = previous.state.x - before.state.x;
        const az = previous.state.z - before.state.z;
        const segment = Math.hypot(ax, az);

        if (segment > 0.5) curvature = clamp(Math.atan2(ax * vz - az * vx, ax * vx + az * vz) / segment, -0.06, 0.06);
      }

      const sine = Math.sin(curvature * 0.25);
      const cosine = Math.cos(curvature * 0.25);

      for (let i = 0; i < Math.max(1, Math.round(lead / 0.25)); i++) {
        const x = hx;
        hx = hx * cosine - hz * sine;
        hz = x * sine + hz * cosine;
        state.x += hx * 25;
        state.z += hz * 25;
      }

      if (base && span >= 0.5) {
        state.roadTime = Math.max(
          0,
          Math.trunc(head.state.roadTime + ((head.state.roadTime - base.state.roadTime) / span) * lead),
        );
        state.roadPosition = Math.max(
          0,
          Math.trunc(head.state.roadPosition + ((head.state.roadPosition - base.state.roadPosition) / span) * lead),
        );
        state.yAltitude += clamp((head.state.yAltitude - base.state.yAltitude) / span, -25, 25) * lead;
      }

      this.heading = [hx, hz];

      return { state, hx, hz, sign: head.sign };
    }

    const target = head.distance + offset;
    const first = this.entries[0];

    if (!first) return null;

    if (target <= first.distance)
      return {
        state: clone(PlayerStateSchema, first.state),
        hx: this.heading[0],
        hz: this.heading[1],
        sign: first.sign,
      };
    let index = this.entries.length - 1;

    while (index > 0 && (this.entries[index - 1]?.distance ?? 0) > target) index--;
    const a = this.entries[index - 1];
    const b = this.entries[index];

    if (!a || !b) return null;

    const fraction = (target - a.distance) / Math.max(0.001, b.distance - a.distance);

    const state = interpolate(a.state, b.state, fraction);
    // World coordinates remain continuous through a junction, even when roadTime changes units.
    state.x = lerp(a.state.x, b.state.x, fraction);
    state.z = lerp(a.state.z, b.state.z, fraction);
    state.yAltitude = lerp(a.state.yAltitude, b.state.yAltitude, fraction);
    const length = Math.hypot(b.state.x - a.state.x, b.state.z - a.state.z);

    if (length > 0.000001) this.heading = [(b.state.x - a.state.x) / length, (b.state.z - a.state.z) / length];

    return { state, hx: this.heading[0], hz: this.heading[1], sign: b.sign };
  }
}
