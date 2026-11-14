import type { ResolvedConfig } from '#src/config/index';
import type { PlayerProfile } from '#src/protocol/generated/profile_pb';
import type { PlayerState } from '#src/protocol/generated/udp-node-msgs_pb';
import { clamp, continuous, interpolate, Random } from '#src/world/geometry';
import type { RiderPool } from '#src/world/riders';

const rank = (preference: string) => (preference === 'front' ? 0 : preference === 'back' ? 2 : 1);

export interface ReplayRider {
  profile: PlayerProfile;
  states: PlayerState[];
  position: number;
  folder: string;
  pacer: boolean;
}

type PelotonConfig = ResolvedConfig['pelotons'][number];

interface Follower {
  profile: PlayerProfile;
  slot: number;
  gap: number;
  lateral: number;
  strength: number;
  cadence: number;
  resting: number;
  maximum: number;
  heart: number;
  ftp: number;
  gapNoise: number;
  lateralNoise: number;
  gapJitter: number;
  lateralJitter: number;
  previous: number | null;
  preference: string;
}

/** Followers use cumulative route distance, including grade and bounded relative motion.
Slot shuffles are synchronous swaps admitted by nextShuffle; replay wrap is owned
by Simulation.tick. previous=null initializes motion, not a paused rider state.
*/
export class Peloton {
  readonly riders: Follower[] = [];
  readonly slots: [number, number][] = [];
  readonly starts: number[] = [];
  readonly lengths: number[] = [];
  readonly grades: number[];
  readonly rng: Random;
  readonly length: number;
  nextShuffle = 0;
  constructor(
    readonly index: number,
    readonly pacer: ReplayRider,
    readonly config: PelotonConfig,
    pool: RiderPool,
  ) {
    this.rng = new Random(Number(pacer.profile.id));
    let distance = 0;
    const raw: number[] = [];

    for (let i = 0; i < pacer.states.length; i++) {
      const a = pacer.states[i];
      const b = pacer.states[(i + 1) % pacer.states.length];

      if (!a || !b) continue;
      const elapsed = Number(b.worldTime - a.worldTime);
      const seconds = elapsed > 0 && elapsed < 5000 ? elapsed / 1000 : 1;

      const length = Math.max(((a.speed + b.speed) / 2 / 3_600_000) * seconds, 0.01);

      this.starts.push(distance);
      this.lengths.push(length);
      distance += length;
      raw.push(continuous(a, b) && length > 1 ? clamp((b.yAltitude - a.yAltitude) / 100 / length, -0.25, 0.25) : 0);
    }

    this.length = distance;
    this.grades = raw.map(
      (_, i) =>
        Array.from({ length: 7 }, (_, k) => raw[(i + k - 3 + raw.length) % raw.length] ?? 0).reduce(
          (sum, value) => sum + value,
          0,
        ) / 7,
    );

    const powers = pacer.states.filter((state) => state.power > 0).map((state) => state.power);

    const wkg =
      powers.length > 0
        ? powers.reduce((sum, value) => sum + value, 0) / powers.length / (pacer.profile.weightInGrams / 1000 || 75)
        : 3;

    const count = Math.min(200, Math.max(config.bots, config.riders.length));

    for (let i = 0; i < count; i++) {
      const spec = config.riders[i] ?? {};
      const profile = pool.profile(BigInt(8_000_001 + index * 1000 + i), spec);
      profile.weightInGrams = Math.round(
        (spec.weight ?? this.rng.between(profile.isMale ? 64 : 52, profile.isMale ? 84 : 68)) * 1000,
      );
      profile.heightInMillimeters = Math.round(
        (spec.height ?? this.rng.between(profile.isMale ? 170 : 158, profile.isMale ? 192 : 178)) * 10,
      );

      const strength = clamp(spec.strength ?? 1 + this.rng.gaussian(0.07), 0.5, 1.5);

      const resting = this.rng.between(52, 66);
      this.riders.push({
        profile,
        slot: i,
        gap: 0,
        lateral: 0,
        strength,
        cadence: spec.cadence ?? this.rng.between(80, 96),
        resting,
        maximum: spec.maxHeartRate ?? this.rng.between(176, 196),
        heart: resting,
        ftp: ((wkg / 0.8) * strength * profile.weightInGrams) / 1000,
        gapNoise: 0,
        lateralNoise: 0,
        gapJitter: this.rng.gaussian(0.3),
        lateralJitter: this.rng.gaussian(config.lateralSpacing * 0.15),
        previous: null,
        preference: spec.position ?? 'any',
      });
    }

    const beside = Math.min(config.besidePacer, count);

    for (let i = 0; i < beside; i++)
      this.slots.push([
        0.6 + Math.floor(i / 2) * config.rowGap * 0.3,
        (i % 2 ? 1 : -1) * config.lateralSpacing * (1 + Math.floor(i / 2)),
      ]);

    const columns = config.columns || clamp(Math.round(Math.sqrt(count / 2.5)) + 1, 2, 6);

    for (let row = 1; this.slots.length < count; row++) {
      const width = Math.min(columns, row + 1);

      const stagger = width === columns ? config.lateralSpacing * 0.25 * (row % 2 ? 1 : -1) : 0;

      for (let column = 0; column < width && this.slots.length < count; column++)
        this.slots.push([row * config.rowGap, (column - (width - 1) / 2) * config.lateralSpacing + stagger]);
    }

    const order = this.riders
      .map((rider) => ({
        rider,
        rank: rank(rider.preference) + this.rng.value() * 1.5,
      }))
      .sort((a, b) => a.rank - b.rank);

    for (const [index, entry] of order.entries()) {
      entry.rider.slot = index;
      entry.rider.gap = this.slots[index]?.[0] ?? 0;
      entry.rider.lateral = this.slots[index]?.[1] ?? 0;
    }
  }
  tick(now: number, time: bigint, seconds = 1) {
    if (this.pacer.states.length === 0 || !this.length) return [];

    if (this.config.dynamics > 0 && now >= this.nextShuffle && this.riders.length > 1) {
      const rider = this.rng.pick(this.riders);

      const direction = rider.preference === 'front' ? -1 : rider.preference === 'back' ? 1 : this.rng.pick([-1, 1]);

      const target = clamp(rider.slot + direction * Math.floor(this.rng.between(1, 4)), 0, this.riders.length - 1);

      const other = this.riders.find((peer) => peer.slot === target);

      if (other) {
        other.slot = rider.slot;
        rider.slot = target;
      }

      this.nextShuffle = now + this.config.shuffleInterval * this.rng.between(0.5, 1.5);
    }

    const grade = this.grades[this.pacer.position] ?? 0;

    return this.riders.map((rider) => {
      const slot = this.slots[rider.slot] ?? [0, 0];
      const excess = Math.max(0, grade - 0.03);

      const target =
        slot[0] * (1 + excess * 6 * this.config.climbStretch) +
        Math.min(this.config.maxDrop, excess * 1000 * Math.max(0, 1 - rider.strength) * this.config.climbStretch) +
        rider.gapJitter;

      rider.gap += clamp((target - rider.gap) * 0.25, -0.9 * seconds, 0.9 * seconds);
      rider.lateral += clamp(
        (slot[1] + rider.lateralJitter - rider.lateral) * 0.3,
        -50_000 * seconds,
        50_000 * seconds,
      );
      rider.gapNoise += -rider.gapNoise * 0.15 + this.rng.gaussian(0.12 * this.config.dynamics);
      rider.lateralNoise += -rider.lateralNoise * 0.15 + this.rng.gaussian(4000 * this.config.dynamics);
      const gap = Math.max(0.3, rider.gap + rider.gapNoise);

      const change = rider.previous === null ? 0 : (gap - rider.previous) / seconds;

      rider.previous = gap;

      const distance = ((((this.starts[this.pacer.position] ?? 0) - gap) % this.length) + this.length) % this.length;

      let index = this.starts.findIndex((start, i) => distance >= start && distance < start + (this.lengths[i] ?? 0));

      if (index < 0) index = 0;
      const a = this.pacer.states[index];
      const b = this.pacer.states[(index + 1) % this.pacer.states.length];

      if (!a || !b) throw new Error('Empty pacer route');

      const state = interpolate(a, b, clamp((distance - (this.starts[index] ?? 0)) / (this.lengths[index] ?? 1), 0, 1));

      state.id = rider.profile.id;
      state.watchingRiderId = state.id;
      state.justWatching = false;
      state.groupId = 0n;
      state.worldTime = time - 300n;
      state.roadPosition = Math.round(
        clamp(state.roadPosition + clamp(rider.lateral + rider.lateralNoise, -300_000, 300_000), 9_300_000, 10_700_000),
      );
      const speed = state.speed / 3_600_000;
      let draft = gap < this.config.rowGap * 0.6 ? 1 : this.config.draft;
      draft += (1 - draft) * clamp(grade / 0.06, 0, 1);
      state.power =
        state.power <= 0
          ? 0
          : Math.max(
              0,
              Math.round(
                (((state.power / (this.pacer.profile.weightInGrams / 1000 || 75)) * rider.profile.weightInGrams) /
                  1000) *
                  draft *
                  (1 + (Math.max(0, -change) / Math.max(speed, 1)) * 4) *
                  (1 + this.rng.gaussian(0.04)),
              ),
            );
      state.speed = Math.round(Math.max(0, speed - change) * 3_600_000);
      state.cadenceUHz =
        state.power <= 0
          ? 0
          : Math.round(
              (Math.max(
                0,
                rider.cadence * (0.95 + 0.1 * Math.min(1.5, state.power / Math.max(rider.ftp, 1))) +
                  this.rng.gaussian(1.5) -
                  (grade > 0.06 ? 8 : 0),
              ) *
                1_000_000) /
                60,
            );

      const heart =
        rider.resting +
        (rider.maximum - rider.resting) * (0.35 + 0.65 * 0.85 * Math.min(1.2, state.power / Math.max(rider.ftp, 1)));

      rider.heart += (Math.min(heart, rider.maximum) - rider.heart) * 0.05;
      state.heartrate = Math.round(rider.heart);

      return state;
    });
  }
}
