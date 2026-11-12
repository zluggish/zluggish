import type { ResolvedConfig } from '#src/config/index';
import type { PlayerProfile } from '#src/protocol/generated/profile_pb';
import type { PlayerState } from '#src/protocol/generated/udp-node-msgs_pb';
import { UserBikeAction } from '#src/protocol/generated/udp-node-msgs_pb';
import { clamp, Random, Trail } from '#src/world/geometry';
import { course, forward, road } from '#src/world/state';
import type { RiderPool } from '#src/world/riders';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

type BlobConfig = ResolvedConfig['soloBlob'];

type Mode = 'attack' | 'hammer' | 'toast' | 'lead' | null;

interface BlobRider {
  profile: PlayerProfile;
  slot: number;
  gap: number;
  lateral: number;
  strength: number;
  phase: 'approach' | 'pull' | null;
  until: number;
  side: number;
  dropping: boolean;
  dropSide: number;
  rate: number;
  noise: number;
  wanderGap: number;
  wanderLat: number;
  blocked: number;
  state: PlayerState | null;
}

let generation = Math.floor(Date.now() / 1000) % 33;

export class Blob {
  readonly trail: Trail;
  readonly riders: BlobRider[] = [];
  slots: [number, number][] = [];
  readonly steps: number[];
  readonly front: [number, number][] = [];
  readonly tail: [number, number][] = [];
  readonly roadLimits: Record<string, [number, number]>;
  readonly roadWidths: Record<string, [number, number, number][]>;
  readonly reach = new Map<string, [number, number]>();
  mode: Mode = null;
  modeUntil = 0;
  grade = 0;
  shift = 0;
  nextShuffle: number;
  nextPull: number;
  nextFormation: number;
  nextTurn: number;
  leaders: number;
  resets = 0;
  constructor(
    readonly playerId: bigint,
    readonly index: number,
    readonly config: BlobConfig,
    pool: RiderPool,
    assets: string,
    readonly now: () => number = () => performance.now() / 1000,
    readonly rng = new Random(),
  ) {
    this.trail = new Trail(now);
    generation = (generation + 1) % 33;
    this.steps = Array.from({ length: 32 }, () => rng.between(1, 1.4));
    this.leaders = config.riders >= 4 ? clamp(Math.round(config.riders * 0.33), 1, 4) : 0;
    this.roadLimits = z
      .record(z.string(), z.tuple([z.number(), z.number()]))
      .parse(JSON.parse(readFileSync(resolve(assets, 'data/road_limits.txt'), 'utf8')));
    this.roadWidths = z
      .record(z.string(), z.array(z.tuple([z.number(), z.number(), z.number()])))
      .parse(JSON.parse(readFileSync(resolve(assets, 'data/road_width_profile.txt'), 'utf8')));

    for (let i = 0; i < config.riders; i++)
      this.riders.push({
        profile: pool.profile(BigInt(8_500_001 + index * 1000 + generation * 30 + i), {}, config.onlyKitted),
        slot: i,
        gap: 5,
        lateral: 0,
        strength: clamp(1 + rng.gaussian(0.07), 0.55, 1.45),
        phase: null,
        until: 0,
        side: 0.9,
        dropping: false,
        dropSide: 1,
        rate: 0,
        noise: 0,
        wanderGap: 0,
        wanderLat: 0,
        blocked: 0,
        state: null,
      });
    this.scatterPool(this.front, [], 0.5, clamp(config.maxLead, 4, 11));
    this.scatterPool(
      this.tail,
      this.front.filter(([gap]) => gap < 4).map(([gap, lat]) => [-gap, lat]),
      0.8,
      40,
    );
    this.form();

    for (const rider of this.riders) {
      const slot = this.slots[rider.slot];

      if (!slot) {
        continue;
      }

      rider.gap = slot[0];
      rider.lateral = slot[1];
    }

    this.nextShuffle = now() + this.wait(config.shuffleInterval);
    this.nextPull = now() + this.wait(config.pullInterval, 0.4);
    this.nextFormation = now() + this.wait(config.formationInterval, 0.6);
    this.nextTurn = now() + config.turnInterval;
  }
  wait(base: number, spread = 0.5) {
    return Math.max(5, base * this.rng.between(1 - spread, 1 + spread));
  }
  scatterPool(points: [number, number][], obstacles: [number, number][], start: number, depth: number) {
    const cfg = this.config;

    const longitudinal = Math.max(1.7, cfg.scatterGap, cfg.keepApartLong * 1.05);

    const lateral = Math.max(0.9, cfg.keepApart * 1.15, cfg.scatterSide, cfg.lateralSpacing);

    const half = clamp(cfg.scatterWidth / 2, 1, 3.2);
    const band = longitudinal * 0.9;
    const beside = clamp(cfg.scatterBeside, 1, 2.5);

    for (let position = start; points.length < 30 && position < start + depth; position += band * 0.5) {
      let fails = 0;

      while (fails < 150 && points.length < 30) {
        const gap = this.rng.between(position, position + band);
        const lat = this.rng.between(-half, half);

        const free =
          (gap / (start === 0.5 ? Math.max(1.7, cfg.leadGap) : 2.2)) ** 2 + (lat / beside) ** 2 >= 1 &&
          [...points, ...obstacles].every(
            ([other, side]) => ((gap - other) / longitudinal) ** 2 + ((lat - side) / lateral) ** 2 >= 1,
          );

        if (free) {
          points.push([gap, lat]);
          fails = 0;
        } else fails++;
      }
    }
  }
  form() {
    const cfg = this.config;
    const count = this.riders.length;
    let rowGap = cfg.rowGap;
    let leadGap = cfg.leadGap;
    let leaders = this.leaders;

    switch (this.mode) {
      case 'hammer': {
        rowGap *= 0.7;
        leadGap *= 0.75;
        leaders = Math.min(3, Math.max(1, count - 3));

        break;
      }

      case 'attack': {
        rowGap *= 0.85;
        leadGap *= 0.85;
        leaders = count >= 4 ? Math.max(1, Math.min(3, Math.floor((count - 1) / 3))) : 0;

        break;
      }

      case 'toast': {
        rowGap *= 1.15;
        leaders = count >= 5 ? Math.max(1, Math.min(2, Math.floor((count - 1) / 4))) : 0;

        break;
      }

      case 'lead': {
        leaders = 0;
        break;
      }
      // No default
    }

    const slots: [number, number][] = [];

    if (cfg.scatter) {
      const front = this.front.slice(0, Math.min(leaders, count));
      const tail = this.tail.slice(0, count - front.length);
      slots.push(...front.map(([gap, lat]): [number, number] => [-gap, lat]), ...tail);
    } else {
      let lead = 0;

      for (let i = 0; i < Math.min(leaders, count); i++) {
        lead += leadGap * (this.steps[i] ?? 1);
        slots.push([-lead, cfg.leadLateral * (i % 2 ? -1 : 1)]);
      }

      const maxLead = clamp(cfg.maxLead, 2, 11);

      if (lead > maxLead) for (const slot of slots) slot[0] *= maxLead / lead;
      const remaining = count - slots.length;

      if (remaining === 1) slots.push([2.2, 0]);

      if (remaining >= 2) {
        slots.push([2.2, -cfg.lateralSpacing], [2.2, cfg.lateralSpacing]);

        const rowsFit = Math.max(1, Math.floor((cfg.tailGap - 2.2) / rowGap + 0.000001));

        const columns = cfg.columns || clamp(Math.ceil((remaining - 2) / rowsFit), 2, 5);

        for (let row = 1; slots.length < count; row++) {
          const width = cfg.raggedRows ? clamp(columns + (((row + indexHash(this.playerId)) % 3) - 1), 2, 5) : columns;

          for (let col = 0; col < width && slots.length < count; col++)
            slots.push([
              2.2 + row * rowGap,
              (col - (width - 1) / 2) * cfg.lateralSpacing + cfg.lateralSpacing * 0.25 * (row % 2 ? 1 : -1),
            ]);
        }
      }
    }

    this.assign(slots);
  }
  assign(slots: [number, number][]) {
    const free = new Set(slots.map((_, i) => i));
    // Keep unchanged scattered positions with their riders before assigning new slots.
    const pending = [];

    for (const rider of this.riders) {
      const previous = this.slots[rider.slot];

      const index = previous ? slots.findIndex((slot) => slot[0] === previous[0] && slot[1] === previous[1]) : -1;

      if (this.config.scatter && index >= 0 && free.has(index)) {
        rider.slot = index;
        free.delete(index);
      } else pending.push(rider);
    }

    const costs = pending
      .flatMap((rider) =>
        [...free].map((index) => ({
          rider,
          index,
          cost: (rider.gap - (slots[index]?.[0] ?? 0)) ** 2 + 4 * (rider.lateral - (slots[index]?.[1] ?? 0)) ** 2,
        })),
      )
      .sort((a, b) => a.cost - b.cost);

    const used = new Set<BlobRider>();

    for (const entry of costs)
      if (!used.has(entry.rider) && free.has(entry.index)) {
        entry.rider.slot = entry.index;
        used.add(entry.rider);
        free.delete(entry.index);
      }

    this.slots = slots;
  }
  receive(state: PlayerState, lag: number) {
    this.trail.push(state, lag);
    const side = this.side(state);

    const seen = this.reach.get(side.key) ?? [Math.abs(side.you), Math.abs(side.you)];

    if (side.you > 0 === side.positive && side.you !== 0)
      this.reach.set(side.key, [Math.min(seen[0], Math.abs(side.you)), Math.max(seen[1], Math.abs(side.you))]);
  }
  side(state: PlayerState) {
    let positive = forward(state) !== [7, 11, 13, 17].includes(course(state));
    const you = (state.roadPosition - 10_000_000) / 100_000;

    if (positive && you < -0.5) positive = false;
    else if (!positive && you > 0.5) positive = true;

    return {
      positive,
      you,
      key: `${course(state)}:${road(state)}:${positive ? 'f' : 'r'}`,
    };
  }
  edges(): [number, number] | null {
    const cfg = this.config;
    const head = this.trail.entries.at(-1);

    if (cfg.roadHalfWidth <= 0 || !head) return null;

    if (cfg.roadLimits === 'off')
      return cfg.roadAxisSide > 0
        ? [-cfg.roadHalfWidth, cfg.roadAxisLimit > 0 ? cfg.roadAxisLimit : cfg.roadHalfWidth]
        : [-(cfg.roadAxisLimit > 0 ? cfg.roadAxisLimit : cfg.roadHalfWidth), cfg.roadHalfWidth];
    const side = this.side(head.state);

    let [inner, outer] = this.roadLimits[side.key] ?? [1, Math.max(cfg.roadHalfWidth, 4.4)];

    const t = head.state.roadTime / 1_000_000;

    const factors = (this.roadWidths[`${course(head.state)}:${road(head.state)}`] ?? [])
      .filter(([start, end]) => start <= t + 0.004 && end >= t - 0.004)
      .map((segment) => segment[2]);

    const factor = factors.length > 0 ? Math.min(...factors) : 1;

    if (factor !== 1) outer = clamp(outer * factor, Math.max(inner + 1, 2.3), 6);

    const seen = this.reach.get(side.key) ?? [Math.abs(side.you), Math.abs(side.you)];

    inner = Math.max(0, Math.min(inner, seen[0] - 0.25));
    outer = Math.max(outer, seen[1] + 0.25);

    return side.positive ? [inner, outer] : [-outer, -inner];
  }
  limits(): [number, number] | null {
    const edges = this.edges();
    const head = this.trail.entries.at(-1);

    if (!edges || !head) return null;
    const you = (head.state.roadPosition - 10_000_000) / 100_000;
    let low = edges[0] - you + 0.25;
    let high = edges[1] - you - 0.25;

    if (head.sign < 0) [low, high] = [-high, -low];

    return [low - this.shift, high - this.shift];
  }
  fit(lateral: number) {
    const limits = this.limits();

    return limits
      ? limits[0] <= limits[1]
        ? clamp(lateral, limits[0], limits[1])
        : (limits[0] + limits[1]) / 2
      : lateral;
  }
  gesture(action: UserBikeAction) {
    const now = this.now();

    switch (action) {
      case UserBikeAction.UBA_ELBOW: {
        this.mode = 'attack';
        this.modeUntil = now + 90;
        this.nextPull = now;

        break;
      }

      case UserBikeAction.UBA_HAMMER: {
        this.mode = 'hammer';
        this.modeUntil = now + this.config.hammerTime;
        this.nextPull = now;

        break;
      }

      case UserBikeAction.UBA_TOAST: {
        this.mode = 'toast';
        this.modeUntil = now + this.config.toastTime;
        this.nextPull = this.modeUntil;

        for (const rider of this.riders) rider.phase = null;

        break;
      }

      case UserBikeAction.UBA_BELL: {
        this.mode = this.mode === 'lead' ? null : 'lead';
        this.modeUntil = now + this.config.leadTime;

        break;
      }

      default: {
        return null;
      }
    }

    this.form();

    return this.mode === 'hammer'
      ? 'HAMMER TIME! The group goes full gas.'
      : this.mode === 'toast'
        ? 'Everybody eases off and regroups.'
        : this.mode === 'lead'
          ? 'You lead, we sit in.'
          : this.mode === 'attack'
            ? 'Somebody is coming through.'
            : 'Back to normal, we take the front.';
  }
  rotate() {
    const ordered = [...this.riders].sort((a, b) => (this.slots[a.slot]?.[0] ?? 0) - (this.slots[b.slot]?.[0] ?? 0));

    const front = ordered[0];

    if (!front || ordered.length < 3) return;

    if (this.config.scatter) {
      const path = [front];
      const long = Math.max(1.5, this.config.keepApartLong);
      const apart = Math.max(1, this.config.keepApart);

      while (path.length < ordered.length) {
        const last = path.at(-1);
        const slot = last ? this.slots[last.slot] : undefined;

        if (!slot) break;

        const next = ordered
          .filter(
            (rider) =>
              !path.includes(rider) &&
              !rider.dropping &&
              !rider.phase &&
              (this.slots[rider.slot]?.[0] ?? 0) > slot[0] + 0.8 &&
              (this.slots[rider.slot]?.[0] ?? 0) < slot[0] + 3.2 * long,
          )
          .sort((a, b) => {
            const cost = (rider: BlobRider) =>
              (((this.slots[rider.slot]?.[0] ?? 0) - slot[0]) / long) ** 2 +
              ((1.6 * ((this.slots[rider.slot]?.[1] ?? 0) - slot[1])) / apart) ** 2;

            return cost(a) - cost(b);
          })[0];

        if (!next) break;
        path.push(next);
      }

      if (path.length < 2) return;
      const slots = path.map((rider) => rider.slot);

      for (let i = 1; i < path.length; i++) {
        const rider = path[i];

        if (rider) rider.slot = slots[i - 1] ?? 0;
      }

      front.slot = slots.at(-1) ?? 0;
    } else {
      const slots = ordered.map((rider) => rider.slot);
      ordered.push(front);
      ordered.shift();

      for (const [i, rider] of ordered.entries()) rider.slot = slots[i] ?? 0;
    }

    front.dropping = true;
    front.dropSide =
      clamp(
        Math.max(...this.slots.map(([, lateral]) => Math.abs(lateral))) + 0.9 * Math.max(1, this.config.keepApart),
        1.3,
        4.2,
      ) * (front.lateral >= 0 ? 1 : -1);
  }
  tick(time: bigint, seconds = 0.5) {
    if (!this.trail.ready()) return [];
    const now = this.now();
    const cfg = this.config;

    if (this.mode && now > this.modeUntil) {
      this.mode = null;
      this.form();
      this.nextPull = Math.max(this.nextPull, now + 15);
    }

    const busy = this.riders.some((rider) => rider.phase || rider.dropping);

    if (cfg.turnInterval > 0 && this.mode === null && now >= this.nextTurn && !busy) {
      this.mode = 'lead';
      this.modeUntil = now + cfg.leadTime;
      this.nextTurn = now + cfg.leadTime + cfg.turnInterval;
      this.form();
    }

    if (now >= this.nextFormation && this.mode === null && !busy && cfg.leadSpread > 0) {
      const home = this.riders.length >= 4 ? clamp(Math.round(this.riders.length * 0.33), 1, 4) : 0;

      this.leaders = clamp(
        this.leaders + this.rng.pick([-1, 1]) * Math.ceil(this.rng.between(0, cfg.leadSpread)),
        cfg.fullRange ? 0 : Math.max(1, home - cfg.leadSpread),
        cfg.fullRange ? this.riders.length : Math.min(Math.max(1, this.riders.length - 3), home + cfg.leadSpread),
      );
      this.form();
      this.nextFormation = now + this.wait(cfg.formationInterval, 0.6);
    }

    if (now >= this.nextShuffle) {
      if (!cfg.scatter) {
        const candidates = this.riders.filter((rider) => !rider.phase && (this.slots[rider.slot]?.[0] ?? 0) > 0);

        if (candidates.length > 1) {
          const a = this.rng.pick(candidates);
          const b = this.rng.pick(candidates);

          if (Math.sign(a.lateral) === Math.sign(b.lateral) || Math.abs(a.gap - b.gap) >= 1.5) {
            const slot = a.slot;
            a.slot = b.slot;
            b.slot = slot;
          }
        }
      }

      this.nextShuffle = now + this.wait(cfg.shuffleInterval);
    }

    if (now >= this.nextPull && this.mode !== 'toast' && this.mode !== 'lead' && !busy) {
      if (this.mode === 'attack' || this.mode === 'hammer') {
        const attacker = [...this.riders]
          .filter((rider) => (this.slots[rider.slot]?.[0] ?? 0) > 0)
          .sort((a, b) => b.strength - a.strength)[0];

        if (attacker) {
          attacker.phase = 'approach';
          attacker.side = attacker.lateral >= 0 ? 1.3 : -1.3;
        }
      } else if (cfg.rotate) this.rotate();
      this.nextPull =
        now + this.wait(cfg.pullInterval * (this.mode === 'hammer' ? 0.55 : this.mode === 'attack' ? 0.7 : 1), 0.6);
    }

    const lags = this.trail.entries
      .slice(-12)
      .flatMap((entry) => (entry.lag === null ? [] : entry.lag))
      .sort((a, b) => a - b);

    this.trail.latency = clamp(
      cfg.latencyComp === 'auto' ? (lags[Math.floor(lags.length / 2)] ?? 0) : Number(cfg.latencyComp) || 0,
      0,
      0.6,
    );
    const motion = this.trail.motion();
    this.grade += 0.25 * (this.trail.grade() - this.grade);
    let ramp = clamp((this.grade - 0.02) / 0.02, 0, 1);
    ramp = ramp * ramp * (3 - 2 * ramp);
    const stretch = 1 + ramp * this.grade * 6 * cfg.climbStretch;
    const edges = this.edges();
    const head = this.trail.entries.at(-1);

    if (edges && head && this.slots.length > 0) {
      const you = (head.state.roadPosition - 10_000_000) / 100_000;
      const min = Math.min(...this.slots.map(([, lat]) => lat));
      const max = Math.max(...this.slots.map(([, lat]) => lat));
      const near = head.sign >= 0 ? min : -max;
      const far = head.sign >= 0 ? max : -min;
      const low = edges[0] - you - near + 0.25;
      const high = edges[1] - you - far - 0.25;

      let wanted = (low > high ? (low + high) / 2 : clamp(0, low, high)) * head.sign;

      if (cfg.roadLimits !== 'off')
        wanted = clamp(wanted, -clamp(cfg.maxRoadShift, 0, 4), clamp(cfg.maxRoadShift, 0, 4));
      this.shift += clamp(wanted - this.shift, -seconds, seconds);
    } else this.shift *= 0.9;

    for (const rider of this.riders) this.updateRider(rider, motion.speed, stretch, now, time, seconds);

    return this.riders.flatMap((rider) => (rider.state ? [rider.state] : []));
  }
  updateRider(rider: BlobRider, speed: number, stretch: number, now: number, time: bigint, seconds: number) {
    const cfg = this.config;
    const slot = this.slots[rider.slot];

    if (!slot) return;
    rider.noise = clamp(rider.noise - rider.noise * 0.1 + this.rng.gaussian(0.03), -0.1, 0.1);

    let gap =
      (slot[0] > 0 ? Math.min(slot[0] * stretch, slot[0] + 1) + 0.08 * speed : Math.max(-12, slot[0] - 0.04 * speed)) +
      rider.noise;

    let lateral = slot[1];
    const limits = this.limits();

    if (cfg.roadLimits !== 'off' && limits) {
      const reach =
        lateral >= 0 ? Math.max(...this.slots.map(([, lat]) => lat)) : -Math.min(...this.slots.map(([, lat]) => lat));

      const room = Math.max(0, lateral >= 0 ? limits[1] : -limits[0]);

      if (reach > 0) lateral *= Math.min(1, room / reach);
    }

    lateral += this.rng.gaussian(0.05);

    if (slot[0] > 0) {
      const k = clamp(seconds / Math.max(2, cfg.wanderTime), 0, 1);
      rider.wanderGap = clamp(
        rider.wanderGap * (1 - k) + (cfg.wanderGap / 1.5) * Math.sqrt(2 * k) * this.rng.gaussian(),
        -cfg.wanderGap,
        cfg.wanderGap,
      );
      rider.wanderLat = clamp(
        rider.wanderLat * (1 - k) + (cfg.wanderLateral / 1.5) * Math.sqrt(2 * k) * this.rng.gaussian(),
        -cfg.wanderLateral,
        cfg.wanderLateral,
      );
      const candidateGap = gap + (slot[0] - 2.2 < 0.1 ? 0 : rider.wanderGap);

      const candidateLat = clamp(lateral + (slot[0] - 2.2 < 0.1 ? 0.5 : 1) * rider.wanderLat, -2.6, 2.6);

      if (
        this.riders.every(
          (peer) =>
            peer === rider ||
            !(
              ((peer.gap - candidateGap) / Math.max(1.76, cfg.keepApartLong) / 1.05) ** 2 +
                ((peer.lateral - candidateLat) / Math.max(0.5, cfg.keepApart) / 1.1) ** 2 <
              1
            ),
        )
      ) {
        gap = candidateGap;
        lateral = candidateLat;
      }
    }

    gap = Math.min(gap, cfg.maxDrop);
    let rate = cfg.rotationRate;

    const passRate = 7.2 / (Math.max(4, cfg.passTime) * (this.mode === 'hammer' || this.mode === 'attack' ? 0.6 : 1));

    if (rider.phase === 'approach') {
      const ordered = [...this.riders]
        .filter((peer) => peer !== rider)
        .sort((a, b) => (this.slots[a.slot]?.[0] ?? 0) - (this.slots[b.slot]?.[0] ?? 0));

      const leader = ordered[0];
      lateral = rider.side;

      if (leader) {
        gap = leader.gap - 1.7;

        if (rider.gap - leader.gap < 6) rate = passRate;

        if (rider.gap <= leader.gap - 1.2) {
          const slots = this.slots.map((slot, index) => ({ gap: slot[0], index })).sort((a, b) => a.gap - b.gap);

          const order = [rider, ...ordered.slice(1), leader];

          for (const [index, peer] of order.entries()) peer.slot = slots[index]?.index ?? 0;
          leader.dropping = true;
          leader.dropSide = rider.side > 0 ? -1.3 : 1.3;
          rider.phase = 'pull';
          rider.until =
            now +
            cfg.pullDuration *
              (this.mode === 'hammer' ? 1.6 : this.mode === 'attack' ? 1.3 : 1) *
              this.rng.between(0.7, 1.4);
        }
      } else rider.phase = null;
    } else if (rider.phase === 'pull') {
      rate = passRate;

      if (now >= rider.until) rider.phase = null;
    }

    if (rider.dropping) {
      rate = 0.7;
      lateral = rider.dropSide;

      if (rider.gap >= gap - 1) rider.dropping = false;
    }

    if (Math.abs(gap - rider.gap) > 0.5 && rider.gap > -4 && rider.gap < 3.2) {
      const side = rider.lateral >= 0 ? 1 : -1;

      if (Math.abs(lateral) < 0.9 || lateral * side < 0) lateral = 0.9 * side;
    }

    const previous = rider.gap;

    let nextGap = clamp(rider.gap + clamp(gap - rider.gap, -rate * seconds, rate * seconds), -12, cfg.maxDrop);

    let nextLat = rider.lateral + clamp(lateral - rider.lateral, -0.45 * seconds, 0.45 * seconds);

    if (cfg.keepApart > 0 && Math.abs(nextGap) > 0.5 && !rider.phase && !rider.dropping) {
      const peers = this.riders.filter((peer) => peer !== rider && Math.abs(peer.gap) > 0.5);

      const long = Math.max(1, cfg.keepApartLong);

      const clearance = (gap: number, lat: number) =>
        Math.min(...peers.map((peer) => ((peer.gap - gap) / long) ** 2 + ((peer.lateral - lat) / cfg.keepApart) ** 2));

      if (clearance(nextGap, nextLat) < 1 && rider.blocked <= 5) {
        rider.blocked += seconds;

        const nearest = [...peers].sort(
          (a, b) =>
            Math.abs(a.gap - nextGap) +
            2 * Math.abs(a.lateral - nextLat) -
            Math.abs(b.gap - nextGap) -
            2 * Math.abs(b.lateral - nextLat),
        )[0];

        const direction = nearest
          ? Math.abs(nextLat - nearest.lateral) < 0.05
            ? nearest.lateral <= 0
              ? 1
              : -1
            : nextLat > nearest.lateral
              ? 1
              : -1
          : 1;

        let side = this.fit(clamp(rider.lateral + direction * 0.45 * seconds, -2.6, 2.6));

        if (Math.abs(side - rider.lateral) < 0.2 * 0.45 * seconds)
          side = this.fit(clamp(rider.lateral - direction * 0.45 * seconds, -2.6, 2.6));

        const options: [number, number][] = [
          [nextGap, side],
          [rider.gap, side],
          [rider.gap, rider.lateral],
        ];

        const best =
          options.find(([gap, lat]) => clearance(gap, lat) >= 1) ??
          [...options, [nextGap, nextLat]].sort(
            (a, b) => clearance(b[0] ?? 0, b[1] ?? 0) - clearance(a[0] ?? 0, a[1] ?? 0),
          )[0];

        if (best) {
          nextGap = best[0] ?? 0;
          nextLat = best[1] ?? 0;
        }
      } else rider.blocked = 0;
    } else rider.blocked = 0;
    rider.gap = nextGap;
    rider.lateral = this.fit(nextLat);
    rider.rate += 0.35 * ((rider.gap - previous) / seconds - rider.rate);
    const sample = this.trail.sample(rider.gap);

    if (!sample) return;
    const state = sample.state;
    let offset = rider.lateral * clamp(cfg.lateralScale, 0.2, 4) + this.shift;
    const edges = this.edges();

    if (edges) {
      const position = (state.roadPosition - 10_000_000) / 100_000;
      const low = edges[0] + 0.25;
      const high = edges[1] - 0.25;
      const wanted = position + sample.sign * offset;
      offset = sample.sign * ((low <= high ? clamp(wanted, low, high) : (low + high) / 2) - position);
    }

    state.id = rider.profile.id;
    state.watchingRiderId = state.id;
    state.justWatching = false;
    state.groupId = 0n;
    state.worldTime = time - 300n;

    if (cfg.lateralVia !== 'road') {
      state.x -= sample.hz * offset * 100;
      state.z += sample.hx * offset * 100;
    }

    if (cfg.lateralVia === 'road' || cfg.lateralVia === 'both')
      state.roadPosition = Math.round(
        clamp(state.roadPosition + sample.sign * offset * 100_000, 9_300_000, 10_700_000),
      );
    state.speed = Math.max(0, Math.trunc((speed - rider.rate) * 3_600_000));

    const effort =
      rider.rate < -0.05
        ? 1.18
        : rider.rate > 0.05
          ? 0.9
          : rider.gap < 0
            ? 1 + this.rng.gaussian(0.03)
            : 0.75 + 0.25 * clamp(rider.gap / 10, 0, 1) + this.rng.gaussian(0.03);

    state.power = Math.max(0, Math.trunc(state.power * effort));
    rider.state = state;
  }
}

function indexHash(id: bigint) {
  return Number(id % 12n);
}
