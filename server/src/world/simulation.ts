import { t } from '#src/i18n/index';
import { configSchema } from '#src/config/schema';
import type { Runtime } from '#src/http/runtime';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import type { PlayerState } from '#src/protocol/generated/udp-node-msgs_pb';
import { PlayerStateSchema, UserBikeAction } from '#src/protocol/generated/udp-node-msgs_pb';
import { AssetFiles } from '#src/repositories/files.repository';
import { Metric, metrics } from '#src/repositories/metrics.repository';
import { SettingsService } from '#src/services/settings.service';
import { Blob } from '#src/world/blob';
import { Random, clamp } from '#src/world/geometry';
import { GestureDirector, gestureUpdate } from '#src/world/gestures';
import type { ReplayRider } from '#src/world/peloton';
import { Peloton } from '#src/world/peloton';
import { Recording } from '#src/world/recording';
import { RiderPool, ghostAppearanceSchema } from '#src/world/riders';
import { course, forward, road, worldTime } from '#src/world/state';
import { clone, fromBinary, toBinary } from '@bufbuild/protobuf';
import { readFileSync } from 'node:fs';
import { appendFile, rename, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Effect, Fiber, Schedule, Schema } from 'effect';
import { botCommand } from '#src/dtos/management.dto';

const isBikeAction = Schema.is(Schema.Enum(UserBikeAction));

interface GhostPlayback {
  recording: Recording;
  position: number;
  date: bigint;
  id: bigint;
}

/** Loading and playback are independent: manual regroup may precede lazy loading.
Exhaustion is position >= recording.length per recording; regroup can revive it.
*/
interface RiderGhosts {
  lastRoadTime: number;
  loading: 'waiting' | 'loading' | 'loaded';
  playback: 'waiting' | 'playing';
  startRoad: number;
  startTime: number;
  last: number;
  playbacks: Array<GhostPlayback>;
}

const ahead = (state: PlayerState, time: number) =>
  Math.abs(state.roadTime - time) < 500_000 && (forward(state) ? state.roadTime > time : state.roadTime < time);

export class Simulation {
  readonly replays = new Map<bigint, ReplayRider>();

  readonly pelotons = new Map<string, Peloton>();

  readonly blobs = new Map<bigint, Blob>();

  readonly directors = new Map<bigint, GestureDirector>();

  readonly ghosts = new Map<bigint, RiderGhosts>();

  readonly bookmarks = new Map<bigint, Map<bigint, { state: PlayerState; name: string }>>();

  readonly lastGesture = new Map<bigint, { action: number; time: number }>();

  readonly pool: RiderPool;

  readonly ghostAppearance: (typeof ghostAppearanceSchema)['Type'];

  readonly starts: Record<string, { road: number; time: number }>;

  readonly rng = new Random();

  private ticker: Fiber.Fiber<unknown> | null = null;

  lastPacer = 0;

  lastBot = 0;

  /** Resolves after the first replay load. Later reloads replace replays atomically. */
  readonly ready: Promise<void>;

  private readonly files = new AssetFiles();

  private readonly pending = new Set<Promise<void>>();

  private reloads = 0;

  private closed = false;

  private recording = { queue: Promise.resolve(), size: 0 };

  private autoGroup: {
    id: bigint;
    all: boolean;
    road: number;
    forward: boolean;
  } | null = null;

  constructor(
    readonly runtime: Runtime,
    readonly now: () => number = () => performance.now() / 1000,
  ) {
    this.ghostAppearance = Schema.decodeUnknownSync(ghostAppearanceSchema)(
      runtime.config.ghosts.profileFile ? JSON.parse(readFileSync(runtime.config.ghosts.profileFile, 'utf8')) : {},
    );
    this.pool = new RiderPool(runtime.assets, runtime.config.bots.ridersFile);
    this.starts = Schema.decodeUnknownSync(
      Schema.Record(Schema.String, Schema.Struct({ road: Schema.Finite, time: Schema.Finite })),
    )(JSON.parse(readFileSync(resolve(runtime.assets, 'data/start_lines.txt'), 'utf8')));
    Blob.roads(runtime.assets);
    runtime.world.simulation = this;
    this.ready = this.reload();
  }

  /** Run a background load. Failures are logged; they never stop the simulation. */
  private track(work: Promise<void>) {
    const tracked = work.catch(() => {
      this.runtime.world.lifecycle.log.warn('simulation.load_failed', 'Simulation storage load failed');
    });

    this.pending.add(tracked);
    void tracked.finally(() => this.pending.delete(tracked));
  }

  async idle() {
    await this.ready;

    while (this.pending.size > 0) {
      await Promise.all(this.pending);
    }
    await this.recording.queue;
  }

  /** One tick. A failed tick is logged and skipped: the world keeps moving and the server keeps running. */
  private readonly tickOnce = Effect.sync(() => this.tick()).pipe(
    Effect.catchDefect((error) =>
      Effect.sync(() => {
        this.runtime.world.lifecycle.log.error('simulation.tick_failed', 'Simulation tick failed', {
          error: error instanceof Error ? error : String(error),
        });
      }),
    ),
  );

  /** Tick every 500 ms on a fixed cadence, starting 500 ms from now, and record how late each tick runs. */
  private loop() {
    let expected = performance.now() + 500;

    const measured = Effect.sync(() => {
      const now = performance.now();
      metrics.record(Metric.SimulationTickDelay, Math.max(0, now - expected));
      expected = now + 500;
    }).pipe(Effect.andThen(this.tickOnce));

    return Effect.sleep(500).pipe(Effect.andThen(Effect.repeat(measured, Schedule.fixed(500))));
  }

  start() {
    if (this.ticker) {
      return;
    }
    this.closed = false;
    this.ticker = Effect.runFork(this.loop());
  }

  async close() {
    const ticker = this.ticker;
    this.ticker = null;
    this.closed = true;

    if (ticker) {
      await Effect.runPromise(Fiber.interrupt(ticker));
    }

    return this.idle();
  }

  async reload() {
    const generation = ++this.reloads;
    const storage = this.runtime.config.storageDir;
    const replays = new Map<bigint, ReplayRider>();

    for (const file of await this.files.filesUnder(resolve(storage, 'robopacers'), 'route.bin')) {
      const [profileBytes, routeBytes] = await Promise.all([
        this.files.readAsync(resolve(file, '../profile.bin')),
        this.files.readAsync(file),
      ]);

      if (!profileBytes || !routeBytes) {
        continue;
      }

      try {
        const profile = fromBinary(PlayerProfileSchema, profileBytes);
        const recording = new Recording(routeBytes);
        profile.privacyBits |= 4n;
        profile.ftp = 400;

        if (profile.id > 0n && recording.length > 0) {
          replays.set(profile.id, {
            profile,
            recording,
            position: 0,
            pacer: true,
            folder: basename(resolve(file, '..')),
          });
        }
      } catch {
        this.runtime.world.lifecycle.log.warn('simulation.invalid_pacer', 'Skipping invalid RoboPacer');
      }
    }

    if (this.runtime.config.bots.enabled) {
      let index = 1;

      const folders = await this.files.entriesAsync(storage);

      for (const folder of folders) {
        if (!folder.isDirectory() || !/^\d+$/.test(folder.name)) {
          continue;
        }
        const ownerId = Number(folder.name);
        const owner = this.ownerProfile(ownerId);

        for (const file of await this.files.filesUnder(resolve(storage, folder.name, 'ghosts'), '.bin')) {
          const bytes = await this.files.readAsync(file);

          if (!bytes) {
            continue;
          }

          try {
            const recording = new Recording(bytes);

            if (recording.length === 0) {
              continue;
            }

            for (let copy = 0; copy < this.runtime.config.bots.multiplier; copy++) {
              const id = BigInt(1_000_000 + index + copy * 10_000);
              const profile = this.pool.profile(id);
              profile.ftp = owner?.ftp || 300;
              replays.set(id, {
                profile,
                recording,
                position: Math.floor(this.rng.value() * recording.length),
                pacer: false,
                ownerId: owner ? ownerId : undefined,
                folder: '',
              });
            }

            index++;
          } catch {
            this.runtime.world.lifecycle.log.warn('simulation.invalid_bot', 'Skipping invalid bot recording');
          }
        }
      }
    }

    // A newer reload started during the reads; its result replaces this one.
    if (generation !== this.reloads || this.closed) {
      return;
    }

    for (const id of this.replays.keys()) {
      this.runtime.world.synthetic.delete(id);
      this.runtime.profiles.deleteReplayProfile(id);
    }

    this.replays.clear();

    for (const [id, replay] of replays) {
      this.replays.set(id, replay);
      this.runtime.profiles.setReplayProfile(replay.profile, replay.ownerId);
    }

    this.loadPelotons();

    const ids = new Set([
      this.runtime.config.soloBlob.playerId,
      ...this.runtime.settings.worldIds().flatMap((id) => (id.startsWith('blob:') ? Number(id.slice(5)) : [])),
    ]);

    for (const id of ids) {
      try {
        this.loadBlob(BigInt(id));
      } catch (error) {
        this.runtime.world.lifecycle.log.warn(
          'simulation.blob_load_failed',
          'Skipping a solo blob that could not load',
          {
            playerId: id,
            error: String(error),
          },
        );
      }
    }
    this.tick();
  }

  loadPelotons() {
    for (const group of this.pelotons.values()) {
      for (const rider of group.riders) {
        this.runtime.world.synthetic.delete(rider.profile.id);
        this.runtime.profiles.synthetic.delete(rider.profile.id);
      }
    }

    this.pelotons.clear();

    const entries = new Map(this.runtime.config.pelotons.map((group) => [group.id, group]));

    for (const id of this.runtime.settings.worldIds()) {
      if (!id.startsWith('peloton:')) {
        continue;
      }

      const key = id.slice(8);
      const defaults = entries.get(key);
      const saved = this.runtime.settings.world(id);

      const entry = Schema.decodeUnknownSync(configSchema)({
        pelotons: [{ ...defaults, ...saved, id: key }],
      }).pelotons[0];

      if (entry) {
        entries.set(key, entry);
      }
    }

    const pacers = this.replays
      .values()
      .filter((replay) => replay.pacer)
      .toArray()
      .sort((a, b) => Number(a.profile.id - b.profile.id));

    for (const [id, config] of entries) {
      if (!config.enabled) {
        continue;
      }

      const index = pacers.findIndex(
        (pacer) =>
          String(pacer.profile.id) === String(config.pacer) ||
          pacer.folder.toLowerCase() === String(config.pacer).toLowerCase(),
      );

      const pacer = pacers[index];

      if (!pacer || index >= 500 || this.pelotons.values().some((group) => group.pacer === pacer)) {
        continue;
      }
      const group = new Peloton(index, pacer, config, this.pool);
      this.pelotons.set(id, group);

      for (const rider of group.riders) {
        this.runtime.profiles.synthetic.set(rider.profile.id, rider.profile);
      }
    }
  }

  private ownerProfile(id: number) {
    try {
      return this.runtime.profiles.get(id);
    } catch {
      return;
    }
  }

  private hasFreeBlobSlot(id: bigint): boolean {
    return (
      this.blobs.has(id) || [0, 1, 2, 3].some((index) => this.blobs.values().every((blob) => blob.index !== index))
    );
  }

  loadBlob(id: bigint) {
    const previous = this.blobs.get(id);

    const index =
      previous?.index ?? [0, 1, 2, 3].find((index) => this.blobs.values().every((blob) => blob.index !== index));

    if (previous) {
      for (const rider of previous.riders) {
        this.runtime.world.synthetic.delete(rider.profile.id);
        this.runtime.profiles.synthetic.delete(rider.profile.id);
      }
    }

    this.blobs.delete(id);
    this.directors.delete(id);
    const saved = this.runtime.settings.world(`blob:${id}`);

    const config = Schema.decodeUnknownSync(configSchema)({
      soloBlob: {
        ...this.runtime.config.soloBlob,
        enabled: Number(id) === this.runtime.config.soloBlob.playerId && this.runtime.config.soloBlob.enabled,
        ...saved,
        playerId: Number(id),
      },
    }).soloBlob;

    if (!config.enabled || !config.riders) {
      return;
    }

    if (index === undefined) {
      throw new Error(t('simulation_solo_blob_limit'));
    }

    const owner = this.ownerProfile(Number(id));

    const blob = new Blob(
      id,
      index,
      { ftp: owner?.ftp || 300, weightKg: (owner?.weightInGrams ?? 0) / 1000 },
      config,
      this.pool,
      this.runtime.assets,
      this.now,
    );

    this.blobs.set(id, blob);
    this.directors.set(id, new GestureDirector(blob.rng, this.now(), config.gestureInterval));

    for (const rider of blob.riders) {
      this.runtime.profiles.synthetic.set(rider.profile.id, rider.profile);
    }
    const state = this.runtime.world.online.get(id);

    if (state) {
      blob.receive(state, 0);
    }
  }

  receive(id: bigint, state: PlayerState) {
    const blob = this.blobs.get(id);
    blob?.receive(state, clamp(Number(worldTime() - state.worldTime) / 1000, -5, 5));

    if (blob && blob.trail.resets !== blob.resets) {
      this.loadBlob(id);
    }

    const settings = SettingsService.resolveRiderSettings(
      this.runtime.config.riderDefaults,
      this.runtime.settings.read(Number(id)),
    );

    if (!settings.ghosts.enabled || !state.roadTime) {
      return;
    }

    const ghosts: RiderGhosts = this.ghosts.get(id) ?? {
      lastRoadTime: 0,
      loading: 'waiting',
      playback: 'waiting',
      startRoad: road(state),
      startTime: state.roadTime,
      last: 0,
      playbacks: [],
    };

    this.ghosts.set(id, ghosts);

    if (ghosts.lastRoadTime && state.roadTime !== ghosts.lastRoadTime) {
      if (ghosts.loading === 'waiting') {
        ghosts.loading = 'loading';

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

        this.track(this.loadGhosts(id, ghosts, directories, this.runtime.world.generation(id)));
      }

      if (
        ghosts.playback === 'waiting' &&
        ghosts.playbacks.length > 0 &&
        road(state) === ghosts.startRoad &&
        ahead(state, ghosts.startTime)
      ) {
        this.regroup(id);
      }
    }

    ghosts.lastRoadTime = state.roadTime;
  }

  /** Read recordings without blocking packets. A result attaches only to the
  session and ghost state that requested it; a new login retries the load.
  */
  private async loadGhosts(id: bigint, ghosts: RiderGhosts, directories: Set<string>, generation: number) {
    const recordings: Array<Recording> = [];

    for (const directory of directories) {
      for (const { name } of await this.files.entriesAsync(directory)) {
        if (!name.endsWith('.bin') || recordings.length >= 100) {
          continue;
        }
        const bytes = await this.files.readAsync(resolve(directory, name));

        if (!bytes) {
          continue;
        }

        try {
          const recording = new Recording(bytes);

          if (recording.length > 0) {
            recordings.push(recording);
          }
        } catch {
          this.runtime.world.lifecycle.log.warn('simulation.invalid_ghost', 'Skipping an invalid ghost recording');
        }
      }
    }

    const rider = recordings.length > 0 ? await this.runtime.profiles.load(Number(id)) : null;

    if (this.ghosts.get(id) !== ghosts || this.closed) {
      return;
    }

    if (this.runtime.world.generation(id) !== generation) {
      ghosts.loading = 'waiting';

      return;
    }

    for (const recording of recordings) {
      const ghostId = id + BigInt(ghosts.playbacks.length + 1) * 10_000_000n;

      ghosts.playbacks.push({ id: ghostId, recording, position: 0, date: recording.state(0).worldTime });

      if (!rider) {
        continue;
      }
      const profile = clone(PlayerProfileSchema, rider);
      profile.id = ghostId;
      profile.firstName = '';
      profile.lastName = t('ghost');
      profile.countryCode = 0;
      this.pool.customizeGhost(profile, this.ghostAppearance);
      this.runtime.profiles.synthetic.set(ghostId, profile);
    }

    ghosts.loading = 'loaded';
  }

  regroup(id: bigint) {
    const state = this.runtime.world.online.get(id);
    const ghosts = this.ghosts.get(id);

    if (!state || !ghosts) {
      return;
    }
    ghosts.playback = 'playing';

    for (const ghost of ghosts.playbacks) {
      const index = ghost.recording.nearest(state);

      if (index !== null) {
        ghost.position = index + (ahead(state, ghost.recording.roadTime(index)) ? 1 : 0);
      }
    }

    ghosts.last = 0;
  }

  group(id: bigint, all: boolean) {
    const state = this.runtime.world.online.get(id);

    if (!state) {
      return;
    }
    const seen = new Set<Recording>();

    for (const replay of this.replays.values()) {
      if (replay.pacer || (!all && seen.has(replay.recording))) {
        continue;
      }

      seen.add(replay.recording);
      const index = replay.recording.nearest(state);

      if (index !== null) {
        replay.position = index;
      }
    }
  }

  loadBookmarks(id: bigint) {
    return Promise.try(() => this.readBookmarks(id));
  }

  private readBookmarks(id: bigint) {
    const bookmarks = new Map<bigint, { state: PlayerState; name: string }>();

    for (const row of this.runtime.accounts.repositories.bookmarksRepository.list(Number(id))) {
      try {
        const state = fromBinary(PlayerStateSchema, row.state);
        state.id = 9_000_000n + (id % 1000n) * 1000n + BigInt(bookmarks.size + 1);
        bookmarks.set(state.id, { state, name: row.name });
      } catch {
        this.runtime.world.lifecycle.log.warn('simulation.invalid_bookmark', 'Skipping an invalid bookmark');
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

    if (!safe) {
      return;
    }
    const id = state.id;

    try {
      this.runtime.accounts.repositories.bookmarksRepository.save(
        Number(id),
        course(state),
        state.sport,
        safe,
        toBinary(PlayerStateSchema, state),
      );
    } catch {
      this.runtime.world.lifecycle.log.warn('simulation.bookmark_failed', 'Bookmark could not be saved');

      return;
    }

    this.readBookmarks(id);
  }

  logout(id: bigint) {
    const state = this.runtime.world.online.get(id);

    if (state) {
      this.bookmark(state, state.sport === 1 ? t('last_run') : t('last_ride_label'));
    }
    this.ghosts.delete(id);
    this.runtime.world.personal.delete(id);

    for (const key of this.runtime.profiles.synthetic.keys()) {
      if (key > 10_000_000n && key % 10_000_000n === id) {
        this.runtime.profiles.synthetic.delete(key);
      }
    }
    const blob = this.blobs.get(id);

    if (!blob) {
      return;
    }

    for (const rider of blob.riders) {
      this.runtime.world.synthetic.delete(rider.profile.id);
    }
    this.loadBlob(id);
  }

  gesture(id: bigint, payload: Uint8Array) {
    if (payload.length !== 16) {
      return null;
    }
    const buffer = Buffer.from(payload);

    if (buffer.readBigUInt64LE() !== id) {
      return null;
    }

    const action = buffer.readUInt32LE(8);

    if (!isBikeAction(action)) {
      return null;
    }
    const previous = this.lastGesture.get(id);

    if (previous?.action === action && this.now() - previous.time < 2) {
      return null;
    }
    this.lastGesture.set(id, { action, time: this.now() });

    return this.blobs.get(id)?.gesture(action) ?? null;
  }

  command(id: bigint, command: string, administrator = false) {
    const [name, ...parts] = command.trim().toLowerCase().split(/\s+/);
    const argument = parts.join(' ');

    if (name === 'regroup') {
      this.regroup(id);

      return t('ghosts_regrouped');
    }

    if (name === 'bookmark') {
      const state = this.runtime.world.online.get(id);

      if (state) {
        this.bookmark(state, argument);
      }

      return t('bookmark_saved');
    }

    // These change the world for every rider. Only the management area sends them, on behalf of a rider.
    if (!administrator && Schema.is(botCommand)(name)) {
      return t('simulation_management_hint');
    }

    if (name === 'group' || name === 'groupall') {
      this.group(id, name === 'groupall');

      return t('bots_grouped');
    }

    if (name === 'autogroup' || name === 'autogroupall') {
      this.trackGroup(id, name === 'autogroupall');

      return t('automatic_grouping_enabled');
    }

    if (name === 'stopautogroup' || name === 'disperse') {
      this.autoGroup = null;

      if (name === 'disperse') {
        for (const replay of this.replays.values()) {
          if (!replay.pacer) {
            replay.position = Math.floor(this.rng.value() * replay.recording.length);
          }
        }
      }

      return t('automatic_grouping_stopped');
    }

    if (name === 'blob') {
      const blob = this.blobs.get(id);

      if (!argument) {
        return blob
          ? t('blob_active_riders_mode', { value1: blob.riders.length, value2: blob.mode ?? 'normal' })
          : 'Blob off. Start with .blob <n>.';
      }

      const actions = new Map([
        ['attack', UserBikeAction.UBA_ELBOW],
        ['hammer', UserBikeAction.UBA_HAMMER],
        ['toast', UserBikeAction.UBA_TOAST],
        ['lead', UserBikeAction.UBA_BELL],
      ]);

      const action = actions.get(argument);

      if (action !== undefined) {
        return blob?.gesture(action) ?? t('simulation_blob_required');
      }

      if (['new', 'restart', 'reroll'].includes(argument)) {
        this.loadBlob(id);

        return t('simulation_new_riders_notice');
      }

      const saved = this.runtime.settings.world(`blob:${id}`);

      if (argument === 'record') {
        saved.record = !(blob?.config.record ?? false);
      } else if (argument === 'off' || argument === '0') {
        saved.enabled = false;
      } else if (/^\d+$/.test(argument) && Number(argument) <= 30 && Number(argument) > 0) {
        if (!this.hasFreeBlobSlot(id)) {
          return t('simulation_blob_slots_full');
        }

        saved.enabled = true;
        saved.riders = Number(argument);
      } else {
        return t('simulation_blob_usage');
      }
      this.runtime.settings.saveWorld(`blob:${id}`, saved);
      this.loadBlob(id);

      return this.blobs.has(id) ? t('blob_settings_saved') : t('blob_off');
    }

    if (name === 'peloton') {
      const state = this.runtime.world.online.get(id);

      if (!state) {
        return t('simulation_active_ride_required');
      }

      const score = (replay: ReplayRider) =>
        replay.profile.id === state.watchingRiderId
          ? -1
          : Math.hypot(replay.recording.x(replay.position) - state.x, replay.recording.z(replay.position) - state.z);

      const pacer = this.replays
        .values()
        .filter((replay) => replay.pacer && replay.recording.course(replay.position) === course(state))
        .toArray()
        .sort((a, b) => {
          return score(a) - score(b);
        })[0];

      if (!pacer) {
        return t('simulation_robopacer_missing');
      }

      const existing = [...this.pelotons].find(([, group]) => group.pacer === pacer);

      const key = existing?.[0] ?? `pacer-${pacer.profile.id}`;

      if (!argument) {
        return `${pacer.profile.lastName}: ${existing?.[1].riders.length ?? 0} bots.`;
      }

      if (argument !== 'off' && (!/^\d+$/.test(argument) || Number(argument) > 200)) {
        return 'Usage: .peloton <0..200> | off';
      }
      const saved = this.runtime.settings.world(`peloton:${key}`);
      Object.assign(saved, {
        pacer: Number(pacer.profile.id),
        enabled: argument !== 'off',
        bots: argument === 'off' ? 0 : Number(argument),
      });
      this.runtime.settings.saveWorld(`peloton:${key}`, saved);
      this.loadPelotons();

      return t('peloton_settings_saved');
    }

    return t('invalid_command', { value1: command });
  }

  /** Off -> tracking; switching rider resets the road/direction checkpoint. */
  private trackGroup(id: bigint, all: boolean) {
    this.autoGroup = { id, all, road: -1, forward: false };
  }

  /** Append a blob recording line off the main thread. A slow disk drops lines
  instead of growing the queue without limit.
  */
  private record(line: string) {
    if (this.recording.size >= 1000) {
      return;
    }
    const file = resolve(this.runtime.config.storageDir, 'solo_blob_record.jsonl');
    this.recording.size++;

    this.recording.queue = this.recording.queue
      .then(async () => {
        const size = await stat(file)
          .then((info) => info.size)
          .catch(() => 0);

        if (size > 80 * 1024 * 1024) {
          await rename(file, `${file}.old`);
        }
        await appendFile(file, line);
      })
      .catch(() => {
        this.runtime.world.lifecycle.log.warn('simulation.record_failed', 'Blob recording could not be written');
      })
      .finally(() => {
        this.recording.size--;
      });
  }

  tick() {
    const now = this.now();
    const time = worldTime();
    const world = this.runtime.world;
    const pacers = now - this.lastPacer >= 1;
    const bots = now - this.lastBot >= 3;

    if (pacers) {
      this.lastPacer = now;
    }

    if (bots) {
      this.lastBot = now;
    }

    if (this.autoGroup) {
      const state = world.online.get(this.autoGroup.id);

      if (state && (road(state) !== this.autoGroup.road || forward(state) !== this.autoGroup.forward)) {
        this.group(this.autoGroup.id, this.autoGroup.all);
        this.autoGroup.road = road(state);
        this.autoGroup.forward = forward(state);
      }
    }

    for (const [id, replay] of this.replays) {
      if (!((replay.pacer && pacers) || (!replay.pacer && bots)) && world.synthetic.has(id)) {
        continue;
      }

      replay.position = (replay.position + 1) % replay.recording.length;

      if (replay.position >= replay.recording.length) {
        continue;
      }
      const state = replay.recording.state(replay.position);
      state.id = id;
      state.worldTime = time - 300n;
      state.groupId = 0n;
      world.synthetic.set(id, state);
    }

    if (pacers) {
      for (const group of this.pelotons.values()) {
        for (const state of group.tick(now, time)) {
          world.synthetic.set(state.id, state);
        }
      }
    }

    for (const [id, blob] of this.blobs) {
      const states = blob.tick(time);

      for (const rider of blob.riders) {
        world.synthetic.delete(rider.profile.id);
      }

      for (const state of states) {
        world.synthetic.set(state.id, state);
      }

      const gesture = blob.config.botGestures
        ? this.directors
            .get(id)
            ?.step(now, blob.riders, blob.config.gestureInterval, blob.trail.motion().speed, blob.config.gestureChance)
        : null;

      if (gesture) {
        world.enqueue(gestureUpdate(gesture.action, gesture.state, time), [id]);
      }

      if (!(blob.config.record && states.length > 0)) {
        continue;
      }

      this.record(
        `${JSON.stringify({ time: Number(time), playerId: String(id), mode: blob.mode, grade: blob.grade, shift: blob.shift, riders: blob.riders.map((rider) => ({ id: String(rider.profile.id), gap: rider.gap, lateral: rider.lateral, rate: rider.rate, phase: rider.phase })) })}\n`,
      );
    }

    for (const [id, ghosts] of this.ghosts) {
      if (!(ghosts.playback === 'playing' && now - ghosts.last >= 3)) {
        continue;
      }

      ghosts.last = now;
      const personal = world.personal.get(id) ?? new Map<bigint, PlayerState>();

      for (const ghost of ghosts.playbacks) {
        if (ghost.position >= ghost.recording.length) {
          personal.delete(ghost.id);
          continue;
        }

        const state = ghost.recording.state(ghost.position++);
        state.id = ghost.id;
        state.worldTime = time - 300n;
        state.groupId = 0n;
        personal.set(state.id, state);
      }

      world.personal.set(id, personal);
    }

    for (const [id, bookmarks] of this.bookmarks) {
      const personal = world.personal.get(id) ?? new Map<bigint, PlayerState>();

      for (const [key, bookmark] of bookmarks) {
        const state = clone(PlayerStateSchema, bookmark.state);
        state.worldTime = time - 300n;
        personal.set(key, state);
      }

      world.personal.set(id, personal);
    }
  }
}
