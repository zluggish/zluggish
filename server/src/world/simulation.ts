import { clone, fromBinary, toBinary } from '@bufbuild/protobuf';
import { existsSync, readFileSync, readdirSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { z } from 'zod';
import { configSchema } from '#src/config/schema';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import { PlayerStateSchema, GhostSchema, UserBikeAction } from '#src/protocol/generated/udp-node-msgs_pb';
import type { PlayerState } from '#src/protocol/generated/udp-node-msgs_pb';
import type { Runtime } from '#src/http/runtime';
import { writeDurable } from '#src/node/persistence/files';
import { resolveRiderSettings } from '#src/node/persistence/settings';
import { worldTime, course, road, forward } from '#src/world/state';
import { clamp, Random } from '#src/world/geometry';
import { Blob } from '#src/world/blob';
import { Peloton } from '#src/world/peloton';
import type { ReplayRider } from '#src/world/peloton';
import { RiderPool } from '#src/world/riders';
import { GestureDirector, gestureUpdate } from '#src/world/gestures';

interface GhostPlayback {
  states: PlayerState[];
  position: number;
  date: bigint;
  id: bigint;
}

interface RiderGhosts {
  lastRoadTime: number;
  loaded: boolean;
  started: boolean;
  startRoad: number;
  startTime: number;
  last: number;
  playbacks: GhostPlayback[];
}

const ahead = (state: PlayerState, time: number) =>
  Math.abs(state.roadTime - time) < 500_000 && (forward(state) ? state.roadTime > time : state.roadTime < time);

export function filesUnder(folder: string, suffix: string): string[] {
  if (!existsSync(folder)) return [];

  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(resolve(folder, entry.name), suffix)
      : entry.isFile() && entry.name.endsWith(suffix)
        ? resolve(folder, entry.name)
        : [],
  );
}

export class Simulation {
  readonly replays = new Map<bigint, ReplayRider>();
  readonly pelotons = new Map<string, Peloton>();
  readonly blobs = new Map<bigint, Blob>();
  readonly directors = new Map<bigint, GestureDirector>();
  readonly ghosts = new Map<bigint, RiderGhosts>();
  readonly bookmarks = new Map<bigint, Map<bigint, { state: PlayerState; name: string }>>();
  readonly lastGesture = new Map<bigint, { action: number; time: number }>();
  readonly pool: RiderPool;
  readonly starts: Record<string, { road: number; time: number }>;
  readonly rng = new Random();
  timer: NodeJS.Timeout | null = null;
  lastPacer = 0;
  lastBot = 0;
  autoGroup: {
    id: bigint;
    all: boolean;
    road: number;
    forward: boolean;
  } | null = null;
  constructor(
    readonly runtime: Runtime,
    readonly now: () => number = () => performance.now() / 1000,
  ) {
    this.pool = new RiderPool(runtime.assets, runtime.config.bots.ridersFile);
    this.starts = z
      .record(z.string(), z.object({ road: z.number(), time: z.number() }))
      .parse(JSON.parse(readFileSync(resolve(runtime.assets, 'data/start_lines.txt'), 'utf8')));
    runtime.world.simulation = this;
    this.reload();
  }
  start() {
    if (!this.timer) this.timer = setInterval(() => this.tick(), 500);
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  reload() {
    for (const id of this.replays.keys()) {
      this.runtime.world.synthetic.delete(id);
      this.runtime.profiles.synthetic.delete(id);
    }

    this.replays.clear();
    const storage = this.runtime.config.storageDir;

    for (const file of filesUnder(resolve(storage, 'robopacers'), 'route.bin')) {
      const profileFile = resolve(file, '../profile.bin');

      if (!existsSync(profileFile)) continue;

      try {
        const profile = fromBinary(PlayerProfileSchema, readFileSync(profileFile));

        const states = fromBinary(GhostSchema, readFileSync(file)).states;

        if (profile.id > 0n && states.length > 0)
          this.replays.set(profile.id, {
            profile,
            states,
            position: 0,
            pacer: true,
            folder: basename(resolve(file, '..')),
          });
      } catch {
        console.warn(`Skipping invalid RoboPacer: ${basename(resolve(file, '..'))}`);
      }
    }

    if (this.runtime.config.bots.enabled) {
      let index = 1;

      for (const folder of readdirSync(storage, { withFileTypes: true })) {
        if (!folder.isDirectory() || !/^\d+$/.test(folder.name)) continue;

        for (const file of filesUnder(resolve(storage, folder.name, 'ghosts'), '.bin')) {
          try {
            const states = fromBinary(GhostSchema, readFileSync(file)).states;

            if (states.length === 0) continue;

            for (let copy = 0; copy < this.runtime.config.bots.multiplier; copy++) {
              const id = BigInt(1_000_000 + index + copy * 10_000);
              const profile = this.pool.profile(id);
              this.replays.set(id, {
                profile,
                states,
                position: Math.floor(this.rng.value() * states.length),
                pacer: false,
                folder: '',
              });
            }

            index++;
          } catch {
            console.warn(`Skipping invalid bot recording: ${basename(file)}`);
          }
        }
      }
    }

    for (const [id, replay] of this.replays) this.runtime.profiles.synthetic.set(id, replay.profile);
    this.loadPelotons();

    const ids = new Set([
      this.runtime.config.soloBlob.playerId,
      ...this.runtime.settings.worldIds().flatMap((id) => (id.startsWith('blob:') ? Number(id.slice(5)) : [])),
    ]);

    for (const id of ids) this.loadBlob(BigInt(id));
    this.tick();
  }
  loadPelotons() {
    for (const group of this.pelotons.values())
      for (const rider of group.riders) {
        this.runtime.world.synthetic.delete(rider.profile.id);
        this.runtime.profiles.synthetic.delete(rider.profile.id);
      }

    this.pelotons.clear();

    const entries = new Map(this.runtime.config.pelotons.map((group) => [group.id, group]));

    for (const id of this.runtime.settings.worldIds())
      if (id.startsWith('peloton:')) {
        const key = id.slice(8);
        const defaults = entries.get(key);
        const saved = this.runtime.settings.world(id);

        const entry = configSchema.parse({
          pelotons: [{ ...defaults, ...saved, id: key }],
        }).pelotons[0];

        if (entry) entries.set(key, entry);
      }

    const pacers = this.replays
      .values()
      .filter((replay) => replay.pacer)
      .toArray()
      .sort((a, b) => Number(a.profile.id - b.profile.id));

    for (const [id, config] of entries) {
      if (!config.enabled) continue;

      const index = pacers.findIndex(
        (pacer) =>
          String(pacer.profile.id) === String(config.pacer) ||
          pacer.folder.toLowerCase() === String(config.pacer).toLowerCase(),
      );

      const pacer = pacers[index];

      if (!pacer || index >= 500 || this.pelotons.values().some((group) => group.pacer === pacer)) continue;
      const group = new Peloton(index, pacer, config, this.pool);
      this.pelotons.set(id, group);

      for (const rider of group.riders) this.runtime.profiles.synthetic.set(rider.profile.id, rider.profile);
    }
  }
  loadBlob(id: bigint) {
    const previous = this.blobs.get(id);

    const index =
      previous?.index ?? [0, 1, 2, 3].find((index) => this.blobs.values().every((blob) => blob.index !== index));

    if (previous)
      for (const rider of previous.riders) {
        this.runtime.world.synthetic.delete(rider.profile.id);
        this.runtime.profiles.synthetic.delete(rider.profile.id);
      }

    this.blobs.delete(id);
    this.directors.delete(id);
    const saved = this.runtime.settings.world(`blob:${id}`);

    const config = configSchema.parse({
      soloBlob: {
        ...this.runtime.config.soloBlob,
        enabled: Number(id) === this.runtime.config.soloBlob.playerId && this.runtime.config.soloBlob.enabled,
        ...saved,
        playerId: Number(id),
      },
    }).soloBlob;

    if (!config.enabled || !config.riders) return;

    if (index === undefined) throw new Error('At most four simultaneous solo blobs are supported');

    const blob = new Blob(id, index, config, this.pool, this.runtime.assets, this.now);

    this.blobs.set(id, blob);
    this.directors.set(id, new GestureDirector(blob.rng, this.now(), config.gestureInterval));

    for (const rider of blob.riders) this.runtime.profiles.synthetic.set(rider.profile.id, rider.profile);
    const state = this.runtime.world.online.get(id);

    if (state) blob.receive(state, 0);
  }
  receive(id: bigint, state: PlayerState) {
    const blob = this.blobs.get(id);
    blob?.receive(state, clamp(Number(worldTime() - state.worldTime) / 1000, -5, 5));

    if (blob && blob.trail.resets !== blob.resets) {
      this.loadBlob(id);
    }

    const settings = resolveRiderSettings(this.runtime.config.riderDefaults, this.runtime.settings.read(Number(id)));

    if (!settings.ghosts.enabled || !state.roadTime) return;

    const ghosts = this.ghosts.get(id) ?? {
      lastRoadTime: 0,
      loaded: false,
      started: false,
      startRoad: road(state),
      startTime: state.roadTime,
      last: 0,
      playbacks: [],
    };

    this.ghosts.set(id, ghosts);

    if (ghosts.lastRoadTime && state.roadTime !== ghosts.lastRoadTime) {
      if (!ghosts.loaded) {
        ghosts.loaded = true;

        const folder = resolve(this.runtime.profiles.folder(Number(id)), 'ghosts', String(course(state)));

        const directories = new Set([
          resolve(folder, String(road(state)), ...(forward(state) ? [] : ['reverse'])),
          ...(state.route ? [resolve(folder, String(state.route))] : []),
        ]);

        const start = this.starts[String(state.route)];

        if (start) {
          ghosts.startRoad = start.road;
          ghosts.startTime = start.time;
        }

        for (const directory of directories) {
          if (!existsSync(directory)) continue;

          for (const file of readdirSync(directory)) {
            if (!file.endsWith('.bin') || ghosts.playbacks.length >= 100) continue;

            try {
              const states = fromBinary(GhostSchema, readFileSync(resolve(directory, file))).states;

              if (states.length === 0) continue;

              const ghostId = id + BigInt(ghosts.playbacks.length + 1) * 10_000_000n;

              ghosts.playbacks.push({
                id: ghostId,
                states,
                position: 0,
                date: states[0]?.worldTime ?? 0n,
              });
              const profile = this.runtime.profiles.get(Number(id));
              profile.id = ghostId;
              profile.firstName = '';
              profile.lastName = 'Ghost';
              profile.countryCode = 0;
              this.runtime.profiles.synthetic.set(ghostId, profile);
            } catch {
              console.warn('Skipping an invalid ghost recording');
            }
          }
        }
      }

      if (
        !ghosts.started &&
        ghosts.playbacks.length > 0 &&
        road(state) === ghosts.startRoad &&
        ahead(state, ghosts.startTime)
      )
        this.regroup(id);
    }

    ghosts.lastRoadTime = state.roadTime;
  }
  regroup(id: bigint) {
    const state = this.runtime.world.online.get(id);
    const ghosts = this.ghosts.get(id);

    if (!state || !ghosts) return;
    ghosts.started = true;

    for (const ghost of ghosts.playbacks) {
      const index = this.nearest(state, ghost.states);

      if (index !== null) ghost.position = index + (ahead(state, ghost.states[index]?.roadTime ?? 0) ? 1 : 0);
    }

    ghosts.last = 0;
  }
  nearest(state: PlayerState, states: PlayerState[]) {
    let index: number | null = null;
    let distance = Infinity;

    for (const [i, peer] of states.entries())
      if (course(state) === course(peer) && road(state) === road(peer) && forward(state) === forward(peer)) {
        const delta = Math.abs(state.roadTime - peer.roadTime);

        if (delta < distance) {
          index = i;
          distance = delta;
        }
      }

    return index;
  }
  group(id: bigint, all: boolean) {
    const state = this.runtime.world.online.get(id);

    if (!state) return;
    const seen = new Set<PlayerState[]>();

    for (const replay of this.replays.values())
      if (!replay.pacer && (all || !seen.has(replay.states))) {
        seen.add(replay.states);
        const index = this.nearest(state, replay.states);

        if (index !== null) replay.position = index;
      }
  }
  loadBookmarks(id: bigint) {
    const bookmarks = new Map<bigint, { state: PlayerState; name: string }>();

    for (const file of filesUnder(resolve(this.runtime.profiles.folder(Number(id)), 'bookmarks'), '.bin')) {
      try {
        const state = fromBinary(PlayerStateSchema, readFileSync(file));
        state.id = 9_000_000n + (id % 1000n) * 1000n + BigInt(bookmarks.size + 1);
        bookmarks.set(state.id, { state, name: basename(file, '.bin') });
      } catch {
        console.warn('Skipping an invalid bookmark');
      }
    }

    this.bookmarks.set(id, bookmarks);

    return bookmarks;
  }
  bookmark(state: PlayerState, name: string) {
    const safe = name
      .normalize('NFKD')
      .replaceAll(/[^\w .-]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 120);

    if (!safe) return;
    writeDurable(
      resolve(
        this.runtime.profiles.folder(Number(state.id)),
        'bookmarks',
        String(course(state)),
        String(state.sport),
        `${safe}.bin`,
      ),
      toBinary(PlayerStateSchema, state),
      true,
    );
    this.loadBookmarks(state.id);
  }
  logout(id: bigint) {
    const state = this.runtime.world.online.get(id);

    if (state) this.bookmark(state, state.sport === 1 ? 'Last run' : 'Last ride');
    this.ghosts.delete(id);
    this.runtime.world.personal.delete(id);

    for (const key of this.runtime.profiles.synthetic.keys())
      if (key > 10_000_000n && key % 10_000_000n === id) this.runtime.profiles.synthetic.delete(key);
    const blob = this.blobs.get(id);

    if (!blob) {
      return;
    }

    for (const rider of blob.riders) this.runtime.world.synthetic.delete(rider.profile.id);
    this.loadBlob(id);
  }
  gesture(id: bigint, payload: Uint8Array) {
    if (payload.length !== 16) return null;
    const buffer = Buffer.from(payload);

    if (buffer.readBigUInt64LE() !== id) return null;

    const action = z.nativeEnum(UserBikeAction).safeParse(buffer.readUInt32LE(8));

    if (!action.success) return null;
    const previous = this.lastGesture.get(id);

    if (previous?.action === action.data && this.now() - previous.time < 2) return null;
    this.lastGesture.set(id, { action: action.data, time: this.now() });

    return this.blobs.get(id)?.gesture(action.data) ?? null;
  }
  command(id: bigint, command: string) {
    const [name, ...parts] = command.trim().toLowerCase().split(/\s+/);
    const argument = parts.join(' ');

    if (name === 'regroup') {
      this.regroup(id);

      return 'Ghosts regrouped.';
    }

    if (name === 'bookmark') {
      const state = this.runtime.world.online.get(id);

      if (state) this.bookmark(state, argument);

      return 'Bookmark saved.';
    }

    const user = this.runtime.accounts.get(Number(id));

    if (!user?.is_admin) return 'This command requires the server owner.';

    if (name === 'group' || name === 'groupall') {
      this.group(id, name === 'groupall');

      return 'Bots grouped.';
    }

    if (name === 'autogroup' || name === 'autogroupall') {
      this.autoGroup = {
        id,
        all: name === 'autogroupall',
        road: -1,
        forward: false,
      };

      return 'Automatic grouping enabled.';
    }

    if (name === 'stopautogroup' || name === 'disperse') {
      this.autoGroup = null;

      if (name === 'disperse')
        for (const replay of this.replays.values())
          if (!replay.pacer) replay.position = Math.floor(this.rng.value() * replay.states.length);

      return 'Automatic grouping stopped.';
    }

    if (name === 'blob') {
      const blob = this.blobs.get(id);

      if (!argument)
        return blob
          ? `Blob active: ${blob.riders.length} riders. Mode: ${blob.mode ?? 'normal'}.`
          : 'Blob off. Start with .blob <n>.';

      const actions = new Map([
        ['attack', UserBikeAction.UBA_ELBOW],
        ['hammer', UserBikeAction.UBA_HAMMER],
        ['toast', UserBikeAction.UBA_TOAST],
        ['lead', UserBikeAction.UBA_BELL],
      ]);

      const action = actions.get(argument);

      if (action !== undefined) return blob?.gesture(action) ?? 'Start a blob first.';

      if (['new', 'restart', 'reroll'].includes(argument)) {
        this.loadBlob(id);

        return 'New riders on the road.';
      }

      const saved = this.runtime.settings.world(`blob:${id}`);

      if (argument === 'record') saved.record = !(blob?.config.record ?? false);
      else if (argument === 'off' || argument === '0') saved.enabled = false;
      else if (/^\d+$/.test(argument) && Number(argument) <= 30 && Number(argument) > 0) {
        saved.enabled = true;
        saved.riders = Number(argument);
      } else return 'Usage: .blob <1..30>, new, off, record, hammer, toast, attack, lead';
      this.runtime.settings.saveWorld(`blob:${id}`, saved);
      this.loadBlob(id);

      return this.blobs.has(id) ? 'Blob settings saved.' : 'Blob off.';
    }

    if (name === 'peloton') {
      const state = this.runtime.world.online.get(id);

      if (!state) return 'Start riding first.';

      const score = (replay: ReplayRider) =>
        replay.profile.id === state.watchingRiderId
          ? -1
          : Math.hypot(
              (replay.states[replay.position]?.x ?? 0) - state.x,
              (replay.states[replay.position]?.z ?? 0) - state.z,
            );

      const pacer = this.replays
        .values()
        .filter((replay) => replay.pacer && course(replay.states[replay.position] ?? state) === course(state))
        .toArray()
        .sort((a, b) => {
          return score(a) - score(b);
        })[0];

      if (!pacer) return 'No RoboPacer on this course.';

      const existing = [...this.pelotons].find(([, group]) => group.pacer === pacer);

      const key = existing?.[0] ?? `pacer-${pacer.profile.id}`;

      if (!argument) return `${pacer.profile.lastName}: ${existing?.[1].riders.length ?? 0} bots.`;

      if (argument !== 'off' && (!/^\d+$/.test(argument) || Number(argument) > 200))
        return 'Usage: .peloton <0..200> | off';
      const saved = this.runtime.settings.world(`peloton:${key}`);
      Object.assign(saved, {
        pacer: Number(pacer.profile.id),
        enabled: argument !== 'off',
        bots: argument === 'off' ? 0 : Number(argument),
      });
      this.runtime.settings.saveWorld(`peloton:${key}`, saved);
      this.loadPelotons();

      return 'Peloton settings saved.';
    }

    return `Invalid command: ${command}`;
  }
  tick() {
    const now = this.now();
    const time = worldTime();
    const world = this.runtime.world;
    const pacers = now - this.lastPacer >= 1;
    const bots = now - this.lastBot >= 3;

    if (pacers) this.lastPacer = now;

    if (bots) this.lastBot = now;

    if (this.autoGroup) {
      const state = world.online.get(this.autoGroup.id);

      if (state && (road(state) !== this.autoGroup.road || forward(state) !== this.autoGroup.forward)) {
        this.group(this.autoGroup.id, this.autoGroup.all);
        this.autoGroup.road = road(state);
        this.autoGroup.forward = forward(state);
      }
    }

    for (const [id, replay] of this.replays)
      if ((replay.pacer && pacers) || (!replay.pacer && bots) || !world.synthetic.has(id)) {
        replay.position = (replay.position + 1) % replay.states.length;
        const original = replay.states[replay.position];

        if (!original) continue;
        const state = clone(PlayerStateSchema, original);
        state.id = id;
        state.worldTime = time - 300n;
        state.groupId = 0n;
        world.synthetic.set(id, state);
      }

    if (pacers)
      for (const group of this.pelotons.values())
        for (const state of group.tick(now, time)) world.synthetic.set(state.id, state);

    for (const [id, blob] of this.blobs) {
      const states = blob.tick(time);

      for (const rider of blob.riders) world.synthetic.delete(rider.profile.id);

      for (const state of states) world.synthetic.set(state.id, state);

      const gesture = blob.config.botGestures
        ? this.directors
            .get(id)
            ?.step(now, blob.riders, blob.config.gestureInterval, blob.trail.motion().speed, blob.config.gestureChance)
        : null;

      if (gesture) world.enqueue(gestureUpdate(gesture.action, gesture.state, time), [id]);

      if (!(blob.config.record && states.length > 0)) continue;

      const file = resolve(this.runtime.config.storageDir, 'solo_blob_record.jsonl');

      if (existsSync(file) && statSync(file).size > 80 * 1024 * 1024) renameSync(file, `${file}.old`);
      appendFileSync(
        file,
        `${JSON.stringify({ time: Number(time), playerId: String(id), mode: blob.mode, grade: blob.grade, shift: blob.shift, riders: blob.riders.map((rider) => ({ id: String(rider.profile.id), gap: rider.gap, lateral: rider.lateral, rate: rider.rate, phase: rider.phase })) })}\n`,
      );
    }

    for (const [id, ghosts] of this.ghosts)
      if (ghosts.started && now - ghosts.last >= 3) {
        ghosts.last = now;
        const personal = world.personal.get(id) ?? new Map();

        for (const ghost of ghosts.playbacks) {
          const original = ghost.states[ghost.position++];

          if (!original) {
            personal.delete(ghost.id);
            continue;
          }

          const state = clone(PlayerStateSchema, original);
          state.id = ghost.id;
          state.worldTime = time - 300n;
          state.groupId = 0n;
          personal.set(state.id, state);
        }

        world.personal.set(id, personal);
      }

    for (const [id, bookmarks] of this.bookmarks) {
      const personal = world.personal.get(id) ?? new Map();

      for (const [key, bookmark] of bookmarks) {
        const state = clone(PlayerStateSchema, bookmark.state);
        state.worldTime = time - 300n;
        personal.set(key, state);
      }

      world.personal.set(id, personal);
    }
  }
}
