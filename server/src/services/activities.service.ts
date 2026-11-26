import { t } from '#src/i18n/index';
import { RuntimeContext } from '#src/context';
import { activityMediaSchema } from '#src/dtos/activities.dto';
import { ApplicationError } from '#src/errors';
import { ActivitySchema, FitnessPrivacy } from '#src/protocol/generated/activity_pb';
import type { Activity } from '#src/protocol/generated/activity_pb';
import { ActivityPrivacyType, Sport, StreaksSchema } from '#src/protocol/generated/profile_pb';
import { WA_TYPE, WorldAttributeSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import type { ActivitiesRepository } from '#src/repositories/activities.repository';
import { ActivityStorage, activityDirectoryPattern, activityFolder, imagePath, videoPath } from '#src/activity-storage';
import type { IntegerInput } from '#src/db/values';
import { immediate } from '#src/db/transaction';
import { Metric, metrics } from '#src/repositories/metrics.repository';
import type { RunningJob } from '#src/repositories/jobs.repository';
import { JobsService } from '#src/services/jobs.service';
import type { JobHandler } from '#src/services/jobs.service';
import type { JobType } from '#src/enum';
import { FitService } from '#src/services/fit.service';
import { SettingsService } from '#src/services/settings.service';
import { StreakService } from '#src/services/streak.service';
import { UploadsService } from '#src/services/uploads.service';
import { course, worldTime } from '#src/world/state';
import { StateHistory } from '#src/world/state-history';
import { clearField, clone, create, toBinary } from '@bufbuild/protobuf';
import { dirname, resolve } from 'node:path';
import { Context, Effect, Layer, Option, Schema } from 'effect';

function withoutFit(activity: Activity) {
  const stripped = clone(ActivitySchema, activity);
  clearField(stripped, ActivitySchema.field.fit);

  return stripped;
}

/** The owner sees every activity; other riders see public ones. */
function visible(activity: Activity, viewer: number) {
  return (
    activity.playerId === BigInt(viewer) ||
    (!activity.privateActivity && activity.privacy === ActivityPrivacyType.PUBLIC)
  );
}

function fitnessVisible(activity: Activity, viewer: number) {
  return (
    visible(activity, viewer) &&
    (activity.playerId === BigInt(viewer) || activity.fitnessPrivacy !== FitnessPrivacy.HIDE_SENSITIVE_DATA)
  );
}

/** The activity as viewer may see it: a public summary hides sensitive fitness data. */
function forViewer(activity: Activity, viewer: number) {
  if (!visible(activity, viewer)) {
    throw new ApplicationError({ status: 404 });
  }

  if (fitnessVisible(activity, viewer)) {
    return activity;
  }

  // Construct a public summary: unknown/future protobuf fields must not leak either.
  return create(ActivitySchema, {
    id: activity.id,
    playerId: activity.playerId,
    courseId: activity.courseId,
    name: activity.name,
    startDate: activity.startDate,
    endDate: activity.endDate,
    distanceInMeters: activity.distanceInMeters,
    totalElevation: activity.totalElevation,
    sport: activity.sport,
    date: activity.date,
    privacy: activity.privacy,
    fitnessPrivacy: activity.fitnessPrivacy,
    movingTimeInMs: activity.movingTimeInMs,
  });
}

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const repositories = context.accounts.repositories;
  const uploadsService = yield* UploadsService;
  const streakService = yield* StreakService;
  const fitService = yield* FitService;
  const jobs = yield* JobsService;

  const mediaTokens = new Map<string, { token: Buffer; expires: number; status: 'issued' | 'receiving' }>();

  function issueMedia(id: string) {
    for (const [key, entry] of mediaTokens) {
      if (entry.expires < Date.now()) {
        mediaTokens.delete(key);
      }
    }

    const entry = {
      token: repositories.cryptoRepository.randomBytes(32),
      expires: Date.now() + 900_000,
      status: 'issued' as const,
    };

    mediaTokens.set(id, entry);

    return entry;
  }

  /** issued -> receiving -> consumed; a failed write releases the claim for retry.
  Validate again after reading the body: deleting the activity must not recreate its media.
  */
  async function receiveMedia(id: string, token: Buffer, read: () => Promise<ArrayBuffer>) {
    const entry = mediaTokens.get(id);

    if (
      !entry ||
      entry.status !== 'issued' ||
      entry.expires < Date.now() ||
      token.length !== entry.token.length ||
      !repositories.cryptoRepository.timingSafeEqual(token, entry.token)
    ) {
      throw new ApplicationError({ status: 403 });
    }
    entry.status = 'receiving';

    try {
      if (!repositories.activitiesRepository.findActivityMedia(id)) {
        throw new ApplicationError({ status: 404 });
      }
      const bytes = new Uint8Array(await read());

      if (mediaTokens.get(id) !== entry || entry.expires < Date.now()) {
        throw new ApplicationError({ status: 403 });
      }

      const row = Schema.decodeUnknownOption(activityMediaSchema)(
        repositories.activitiesRepository.findActivityMedia(id),
      );

      if (Option.isNone(row)) {
        throw new ApplicationError({ status: 404 });
      }
      const folder = folderOf(row.value.activity_id);

      if (folder === null) {
        throw new ApplicationError({ status: 404 });
      }
      const path = videoPath(folder, row.value.id, row.value.content_type);
      await repositories.filesRepository.writeDurableAsync(path, bytes, true);

      // The file is durable before the row is ready. The activity can be deleted while
      // the write runs: then the file is removed, not kept as an orphan.
      if (!repositories.activitiesRepository.mediaState('activity_media', id, 'ready')) {
        await repositories.filesRepository.removeAsync(path);
        throw new ApplicationError({ status: 404 });
      }

      mediaTokens.delete(id);
    } catch (error) {
      if (mediaTokens.get(id) === entry) {
        entry.status = 'issued';
      }
      throw error;
    }
  }

  /** A completed activity is immutable: the same save returns the existing result;
  a changed payload or FIT payload is a conflict.
  */
  function finalized(activity: Activity) {
    const saved = repositories.completionRepository.get(activity.id);

    if (!saved) {
      return false;
    }
    const stored = repositories.activitiesRepository.fit(activity.id)?.fit ?? new Uint8Array();

    if (
      !Buffer.from(saved.payload).equals(Buffer.from(toBinary(ActivitySchema, withoutFit(activity)))) ||
      !Buffer.from(stored).equals(Buffer.from(activity.fit))
    ) {
      throw new ApplicationError({
        status: 409,
        message: t('activities_completed_activity_immutable'),
      });
    }

    return true;
  }

  let turn = Promise.resolve();

  let queuedSaves = 0;

  /** Saves from requests run one per event-loop turn: a group of riders that finish
  together cannot hold the main thread for the whole group.
  */
  function saveInTurn(activity: Activity, finish: boolean, validate: () => boolean | void = () => {}) {
    const queued = performance.now();
    metrics.record(Metric.QueueDepth, ++queuedSaves);

    const result = turn
      .then(
        () =>
          new Promise<void>((resolve) => {
            setImmediate(resolve);
          }),
      )
      .then(() => {
        queuedSaves--;
        metrics.record(Metric.QueueWait, performance.now() - queued);

        if (validate() === false) {
          return 'unchanged';
        }

        return save(activity, finish);
      });

    turn = result.then(() => {}).catch(() => {});

    return result;
  }

  /** Draft edits, durable completion and discard are distinct from ending a ride. */
  function save(activity: Activity, finish: boolean) {
    if (finalized(activity)) {
      return 'unchanged';
    }

    if (!finish) {
      repositories.protobufRepository.update('activity', activity.id, ActivitySchema, activity, ['fit']);

      return 'updated';
    }

    if (activity.distanceInMeters < 1) {
      deleteActivity(activity.id, Number(activity.playerId));
      context.world.lifecycle.log.info('activity.discarded', 'Activity discarded', {
        playerId: Number(activity.playerId),
        activityId: activity.id,
      });

      return 'discarded';
    }

    finalize(activity);

    return 'completed';
  }

  function finalize(activity: Activity) {
    try {
      if (!complete(activity)) {
        return;
      }
    } catch (error) {
      context.world.lifecycle.log.error('activity.save_failed', 'Activity save failed', {
        playerId: activity.playerId,
        activityId: activity.id,
        recoverable: true,
        error: error instanceof Error ? error : String(error),
      });
      throw error;
    }

    context.world.lifecycle.log.info('activity.saved', 'Activity saved', {
      playerId: activity.playerId,
      activityId: activity.id,
    });
  }

  /** One transaction commits the activity, its canonical FIT payload, progression, the
  completion record, delivery records and the jobs that publish optional artifacts.
  Provider requests, FIT processing and file writes run after the commit.
  */
  function complete(activity: Activity) {
    const player = Number(activity.playerId);
    const id = Number(activity.id);
    const history = context.world.histories.get(activity.playerId) ?? new StateHistory();

    const settings = SettingsService.resolveRiderSettings(context.config.riderDefaults, context.settings.read(player));

    const providers = Effect.runSync(uploadsService.configured(player));
    const progresses = activity.sport === Sport.CYCLING && activity.distanceInMeters >= 2000;

    const committed = immediate(repositories.db, () => {
      // A concurrent finalization committed first: return its result unchanged.
      if (finalized(activity)) {
        return null;
      }
      repositories.protobufRepository.update('activity', activity.id, ActivitySchema, activity, ['fit']);
      repositories.activitiesRepository.setFit(activity.id, activity.fit);

      const advanced = progresses
        ? StreakService.advancedStreak(Effect.runSync(streakService.streaksFor(player)), activity)
        : null;

      if (advanced) {
        repositories.streakRepository.saveStreaks(player, advanced);
      }
      const snapshot = advanced ? toBinary(StreaksSchema, advanced) : null;

      repositories.completionRepository.insert(
        activity.id,
        player,
        toBinary(ActivitySchema, withoutFit(activity)),
        snapshot,
      );

      for (const provider of providers) {
        if (repositories.uploadsRepository.insert(id, provider)) {
          repositories.jobsRepository.enqueue('delivery', { activityId: id, provider });
        }
      }

      if (activity.fit.length > 0) {
        repositories.jobsRepository.enqueue('power_curve', { activityId: id });
        repositories.jobsRepository.enqueue('fit_export', { activityId: id });
        const file = Number(repositories.activitiesRepository.insertActivityFile(activity.id).lastInsertRowid);
        repositories.jobsRepository.enqueue('chart', { activityId: id, fileId: file });
      }

      return { streak: snapshot };
    });

    if (!committed) {
      return false;
    }

    // The ghost recording is an optional artifact from memory: written after the
    // commit, off the main thread. A crash before the write loses only the recording.
    const state = history.state(-1);

    if (state && settings.ghosts.enabled) {
      void repositories.filesRepository
        .writeDurableAsync(
          resolve(
            context.profiles.folder(player),
            'ghosts',
            String(course(state)),
            ...(state.route
              ? [String(state.route)]
              : [String((state.aux3 >>> 8) & 0xff_ff), ...(state.f19 & 4 ? [] : ['reverse'])]),
            `activity-${activity.id}.bin`,
          ),
          history.ghost(player),
          true,
        )
        .catch(() => {
          context.world.lifecycle.log.warn('activity.ghost_unavailable', 'Ghost recording not saved', {
            activityId: activity.id,
            playerId: activity.playerId,
          });
        });
    }

    if (committed.streak) {
      context.world.enqueue(
        create(WorldAttributeSchema, {
          serverRealm: 1n,
          waType: WA_TYPE.PLAYER_FITNESS_METRICS_UPDATED,
          worldTimeBorn: worldTime(),
          worldTimeExpire: worldTime() + 60_000n,
          timestamp: BigInt(Date.now()) * 1000n,
        }),
        [activity.playerId],
      );
    }

    return true;
  }

  function findActivity(...values: Parameters<ActivitiesRepository['findActivity']>) {
    return repositories.activitiesRepository.findActivity(...values);
  }

  /** The rows go in one transaction with a cleanup job; the job removes the files.
  Historical streak and power-curve contributions stay.
  */
  function deleteActivity(id: bigint, player: number) {
    immediate(repositories.db, () => {
      if (!repositories.activitiesRepository.findActivity(id, player)) {
        throw new ApplicationError({ status: 404 });
      }

      const stored = repositories.activitiesRepository.storageDirectory(id);

      const payload = {
        activityId: Number(id),
        playerId: player,
        directory: stored?.directory ?? '',
      };

      repositories.activitiesRepository.deleteActivityData(id, player);
      repositories.jobsRepository.enqueue('artifact_cleanup', payload);
    });
  }

  function findActivityFile(...values: Parameters<ActivitiesRepository['findActivityFile']>) {
    return repositories.activitiesRepository.findActivityFile(...values);
  }

  function insertActivityFile(...values: Parameters<ActivitiesRepository['insertActivityFile']>) {
    return repositories.activitiesRepository.insertActivityFile(...values);
  }

  function findOwnedActivityFile(...values: Parameters<ActivitiesRepository['findOwnedActivityFile']>) {
    return repositories.activitiesRepository.findOwnedActivityFile(...values);
  }

  /** Reserve the row, write the file durably, then mark the row ready. */
  async function saveImage(player: number, activity: string, jpg: Uint8Array) {
    const folder = folderOf(activity, player);

    if (folder === null) {
      throw new ApplicationError({ status: 404 });
    }
    const id = Number(repositories.activitiesRepository.insertActivityImage(player, activity).lastInsertRowid);
    const path = imagePath(folder, id);

    try {
      await repositories.filesRepository.writeDurableAsync(path, jpg, true);
    } catch (error) {
      repositories.activitiesRepository.mediaState('activity_image', id, 'failed');
      throw error;
    }

    if (!repositories.activitiesRepository.mediaState('activity_image', id, 'ready')) {
      await repositories.filesRepository.removeAsync(path);
      throw new ApplicationError({ status: 404 });
    }

    return id;
  }

  function insertActivityMedia(...values: Parameters<ActivitiesRepository['insertActivityMedia']>) {
    return repositories.activitiesRepository.insertActivityMedia(...values);
  }

  function findActivityMedia(...values: Parameters<ActivitiesRepository['findActivityMedia']>) {
    return repositories.activitiesRepository.findActivityMedia(...values);
  }

  function photos(player: number, activity: bigint) {
    const folder = folderOf(activity, player);

    if (folder === null) {
      return [];
    }
    const paths = [];

    for (const row of Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ id: Schema.Finite, state: Schema.String })),
    )(repositories.activitiesRepository.listActivityImage(player, activity))) {
      if (row.state === 'ready') {
        paths.push(imagePath(folder, row.id));
      }
    }

    for (const row of Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ id: Schema.Finite, content_type: Schema.String, state: Schema.String })),
    )(repositories.activitiesRepository.listActivityMedia(player, activity))) {
      if (row.state === 'ready') {
        paths.push(videoPath(folder, row.id, row.content_type));
      }
    }

    return paths.filter((path) => repositories.filesRepository.existsSync(path));
  }

  function companion(activity: Activity, details = false) {
    const profile = context.profiles.get(Number(activity.playerId));

    const moving = Date.parse(activity.endDate) - Date.parse(activity.startDate);

    const summary = {
      id: Number(activity.id),
      profile: {
        id: String(activity.playerId),
        firstName: profile.firstName,
        lastName: profile.lastName,
        imageSrc: profile.largeAvatarUrl || null,
        approvalRequired: null,
      },
      worldId: Number(activity.courseId),
      name: activity.name,
      sport: activity.sport === 1 ? 'RUNNING' : 'CYCLING',
      startDate: activity.startDate,
      endDate: activity.endDate,
      distanceInMeters: activity.distanceInMeters,
      totalElevation: activity.totalElevation,
      calories: activity.calories,
      primaryImageUrl: '',
      feedImageThumbnailUrl: '',
      lastSaveDate: activity.date,
      movingTimeInMs: Number.isFinite(moving) ? moving : 0,
      avgSpeedInMetersPerSecond: activity.avgSpeed,
      activityRideOnCount: 0,
      activityCommentCount: 0,
      privacy: activity.privateActivity ? 'PRIVATE' : ActivityPrivacyType[activity.privacy],
      eventId: null,
      rideOnGiven: false,
      id_str: String(activity.id),
    };

    return details
      ? {
          ...summary,
          avgWatts: activity.avgWatts,
          maxWatts: activity.maxWatts,
          avgHeartRate: activity.avgHeartRate,
          maxHeartRate: activity.maxHeartRate,
          avgCadenceInRotationsPerMinute: activity.avgCadence,
          maxCadenceInRotationsPerMinute: activity.maxCadence,
          maxSpeedInMetersPerSecond: activity.maxSpeed,
        }
      : summary;
  }

  /** A rider's own activities for the web app. The rider owns them, so fitness privacy does not apply. */
  function own(player: number, id?: string, page?: number) {
    return repositories.activitiesRepository.ownActivities(player, id, page).map((row) => {
      const activity = repositories.protobufRepository.decode(ActivitySchema, row);
      const elapsed = Date.parse(activity.endDate) - Date.parse(activity.startDate);

      return {
        id: String(activity.id),
        name: activity.name,
        world: Number(activity.courseId),
        sport: activity.sport === Sport.RUNNING ? 'running' : 'cycling',
        startDate: activity.startDate || null,
        endDate: activity.endDate || null,
        distanceInMeters: activity.distanceInMeters,
        totalElevation: activity.totalElevation,
        movingTimeInMs: Number(activity.movingTimeInMs) || (Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0),
        calories: activity.calories,
        avgWatts: activity.avgWatts,
        maxWatts: activity.maxWatts,
        normalizedPower: activity.normalizedPower,
        tss: activity.tss,
        avgHeartRate: activity.avgHeartRate,
        maxHeartRate: activity.maxHeartRate,
        avgCadence: activity.avgCadence,
        maxCadence: activity.maxCadence,
        avgSpeed: activity.avgSpeed,
        maxSpeed: activity.maxSpeed,
        fit: Number(row.has_fit) === 1,
        images: Number(row.image_count),
      };
    });
  }

  function ownDetail(player: number, id: string) {
    const [activity] = own(player, id);

    if (!activity) {
      throw new ApplicationError({ status: 404, message: t('activity_not_found') });
    }

    const images = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.Finite, state: Schema.String })))(
      repositories.activitiesRepository.listActivityImage(player, id),
    )
      .filter((row) => row.state === 'ready')
      .map((row) => row.id);

    const fileId = activity.fit ? chartFile(BigInt(id)) : null;
    const path = fileId === null ? null : chartPath(id);

    const chart = path === null ? null : decodeJson(repositories.filesRepository.readFileSync(path, 'utf8'));

    return { ...activity, imageIds: images, chart, chartPending: activity.fit && chart === null };
  }

  /** The canonical FIT payload of an own activity, with a filename safe for a download header. */
  function ownFit(player: number, id: string) {
    const stored = repositories.activitiesRepository.fit(id);

    if (!stored?.fit || stored.player !== player) {
      throw new ApplicationError({ status: 404, message: t('fit_file_not_found') });
    }

    const base = stored.filename
      .normalize('NFKD')
      .replaceAll(/[^\w. -]/g, '_')
      .replace(/^[.\s]+/, '');

    return {
      fit: stored.fit,
      filename: base ? (base.toLowerCase().endsWith('.fit') ? base : `${base}.fit`) : `${id}.fit`,
    };
  }

  function ownImagePath(player: number, activity: string, image: number) {
    const ready = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.Finite, state: Schema.String })))(
      repositories.activitiesRepository.listActivityImage(player, activity),
    ).some((row) => row.id === image && row.state === 'ready');

    const folder = folderOf(activity, player);
    const path = folder === null ? null : imagePath(folder, image);

    if (
      path === null ||
      !ready ||
      !repositories.filesRepository.existsSync(path) ||
      !repositories.filesRepository.statSync(path).isFile()
    ) {
      throw new ApplicationError({ status: 404, message: t('image_not_found') });
    }

    return path;
  }

  function recentActivities(...values: Parameters<ActivitiesRepository['recentActivities']>) {
    return repositories.activitiesRepository.recentActivities(...values);
  }

  function activityById(...values: Parameters<ActivitiesRepository['activityById']>) {
    return repositories.activitiesRepository.activityById(...values);
  }

  function activityFeed(...values: Parameters<ActivitiesRepository['activityFeed']>) {
    return repositories.activitiesRepository.activityFeed(...values);
  }

  function activityChart(...args: Parameters<typeof FitService.activityChart>) {
    return FitService.activityChart(...args);
  }

  function chartNow(bytes: Uint8Array) {
    return FitService.chart(bytes);
  }

  function savePowerCurve(id: number, bytes: Uint8Array) {
    Effect.runSync(fitService.savePowerCurve(id, bytes));
  }

  function updateStreaks(id: number, activity: Activity) {
    Effect.runSync(streakService.updateStreaks(id, activity));
  }

  function rebuildPowerCurves(player: number) {
    immediate(repositories.db, () => {
      repositories.fitnessRepository.deletePowerCurve(player);

      for (const activity of repositories.activitiesRepository.withFit(player)) {
        repositories.jobsRepository.enqueue('power_curve', { activityId: activity });
      }
    });
  }

  function chartFile(activity: bigint) {
    const row = repositories.activitiesRepository.findActivityFile(activity);
    const fileId = row ? Schema.decodeUnknownSync(Schema.Finite)(row.id) : null;

    const path = chartPath(activity);

    if (fileId !== null && path !== null && repositories.filesRepository.existsSync(path)) {
      return fileId;
    }

    // Imported activities can have a canonical FIT payload without a completion record.
    if (!repositories.activitiesRepository.fit(activity)?.fit?.length) {
      return null;
    }

    immediate(repositories.db, () => {
      const id = fileId ?? Number(repositories.activitiesRepository.insertActivityFile(activity).lastInsertRowid);
      repositories.jobsRepository.enqueueOnce('chart', { activityId: Number(activity), fileId: id });
    });

    return null;
  }

  /** The folder of an activity, assigned on first use; null when the activity does not
  exist or belongs to another rider.
  */
  function folderOf(activity: IntegerInput, player?: number) {
    const stored = repositories.activitiesRepository.storageDirectory(activity);

    if (!stored || (player !== undefined && stored.player !== player)) {
      return null;
    }

    return activityFolder(context.profiles.folder(stored.player), stored.directory);
  }

  function chartPath(activity: IntegerInput) {
    const folder = folderOf(activity);

    return folder === null ? null : resolve(folder, ActivityStorage.Chart);
  }

  function exportPath(activity: IntegerInput) {
    const folder = folderOf(activity);

    return folder === null ? null : resolve(folder, ActivityStorage.Fit);
  }

  /** Write a job result to an attempt-specific path. Only the current claim publishes
  it, and only while its activity exists.
  */
  async function publish(job: RunningJob, path: string, data: string | Uint8Array, exists: () => boolean) {
    const attempt = `${path}.${job.claim.token}.tmp`;
    let published = false;

    try {
      await repositories.filesRepository.writeStagedAsync(attempt, data);

      job.commit(() => {
        if (!exists()) {
          return;
        }
        repositories.filesRepository.renameSync(attempt, path);
        published = true;
      });

      if (published) {
        await repositories.filesRepository.syncDirectoryAsync(dirname(path));
      }
    } finally {
      if (!published) {
        await repositories.filesRepository.removeAsync(attempt);
      }
    }
  }

  const register = (type: JobType, handler: Omit<JobHandler, 'run'> & { run: (job: RunningJob) => Promise<void> }) =>
    Effect.runSync(jobs.register(type, { ...handler, run: (job) => Effect.promise(() => handler.run(job)) }));

  function registerJobs() {
    register('power_curve', {
      concurrency: 2,
      attempts: 3,
      timeoutMs: 60_000,
      run: async (job) => {
        const id = job.number('activityId');
        const stored = repositories.activitiesRepository.fit(id);

        if (!stored?.fit || stored.player === null) {
          return;
        }
        const player = stored.player;
        const curve = await FitService.powerBests(stored.fit);

        job.commit(() => {
          if (!repositories.activitiesRepository.findActivity(id, player)) {
            return;
          }
          repositories.fitnessRepository.deleteActivityPowerCurve(id);
          Effect.runSync(fitService.insertPowerBests(player, curve, id));
        });
      },
    });

    register('fit_export', {
      concurrency: 2,
      attempts: 5,
      timeoutMs: 60_000,
      run: async (job) => {
        const id = job.number('activityId');
        const stored = repositories.activitiesRepository.fit(id);

        if (!stored?.fit || stored.player === null) {
          return;
        }
        const player = stored.player;
        const path = exportPath(id);

        if (path === null) {
          return;
        }

        await publish(job, path, stored.fit, () => !!repositories.activitiesRepository.findActivity(id, player));
      },
    });

    register('chart', {
      concurrency: 2,
      attempts: 3,
      timeoutMs: 60_000,
      run: async (job) => {
        const id = job.number('activityId');
        const fileId = job.number('fileId');
        const stored = repositories.activitiesRepository.fit(id);

        if (!stored?.fit) {
          return;
        }
        const path = chartPath(id);

        if (path === null) {
          return;
        }
        const chart = await FitService.chart(stored.fit);

        await publish(
          job,
          path,
          JSON.stringify(chart),
          () => !!repositories.activitiesRepository.findOwnedActivityFile(fileId, id),
        );
      },
    });

    register('artifact_cleanup', {
      concurrency: 1,
      attempts: 5,
      timeoutMs: 120_000,
      // Jobs queued before the activity folders carry no directory: the folder
      // migration removed their files.
      run: async (job) => {
        const player = job.number('playerId');
        const directory = String(job.payload['directory'] ?? '');

        if (!activityDirectoryPattern.test(directory)) {
          return;
        }

        await repositories.filesRepository.removeTreeAsync(activityFolder(context.profiles.folder(player), directory));
      },
    });

    // Legacy completions finished by the storage migration create their deliveries at
    // runtime, where the operator configuration is known.
    register('completion_deliveries', {
      concurrency: 1,
      attempts: 3,
      timeoutMs: 30_000,
      run: async (job) => {
        const id = job.number('activityId');
        const saved = repositories.completionRepository.get(BigInt(id));

        if (!saved) {
          return;
        }
        const providers = Effect.runSync(uploadsService.configured(saved.player_id));

        job.commit(() => {
          for (const provider of providers) {
            if (repositories.uploadsRepository.insert(id, provider)) {
              repositories.jobsRepository.enqueue('delivery', { activityId: id, provider });
            }
          }
        });

        await Promise.resolve();
      },
    });
  }

  registerJobs();

  return {
    issueMedia: Effect.fn('ActivitiesService.issueMedia')(function* (id: string) {
      return issueMedia(id);
    }),
    /** issued -> receiving -> consumed; a failed write releases the claim for retry.
  Validate again after reading the body: deleting the activity must not recreate its media.
  */
    receiveMedia: Effect.fn('ActivitiesService.receiveMedia')(function* (
      id: string,
      token: Buffer,
      read: () => Promise<ArrayBuffer>,
    ) {
      return yield* Effect.promise(() => receiveMedia(id, token, read));
    }),
    /** A completed activity is immutable: the same save returns the existing result;
  a changed payload or FIT payload is a conflict.
  */
    finalized: Effect.fn('ActivitiesService.finalized')(function* (activity: Activity) {
      return finalized(activity);
    }),
    /** Saves from requests run one per event-loop turn: a group of riders that finish
  together cannot hold the main thread for the whole group.
  */
    saveInTurn: Effect.fn('ActivitiesService.saveInTurn')(function* (
      activity: Activity,
      finish: boolean,
      validate: () => boolean | void = () => {},
    ) {
      return yield* Effect.promise(() => saveInTurn(activity, finish, validate));
    }),
    /** Draft edits, durable completion and discard are distinct from ending a ride. */
    save: Effect.fn('ActivitiesService.save')(function* (activity: Activity, finish: boolean) {
      return save(activity, finish);
    }),

    finalize: Effect.fn('ActivitiesService.finalize')(function* (activity: Activity) {
      return finalize(activity);
    }),

    findActivity: Effect.fn('ActivitiesService.findActivity')(function* (
      ...values: Parameters<ActivitiesRepository['findActivity']>
    ) {
      return findActivity(...values);
    }),
    /** The rows go in one transaction with a cleanup job; the job removes the files.
  Historical streak and power-curve contributions stay.
  */
    deleteActivity: Effect.fn('ActivitiesService.deleteActivity')(function* (id: bigint, player: number) {
      return deleteActivity(id, player);
    }),

    visible: Effect.fn('ActivitiesService.visible')(function* (activity: Activity, viewer: number) {
      return visible(activity, viewer);
    }),

    fitnessVisible: Effect.fn('ActivitiesService.fitnessVisible')(function* (activity: Activity, viewer: number) {
      return fitnessVisible(activity, viewer);
    }),

    forViewer: Effect.fn('ActivitiesService.forViewer')(function* (activity: Activity, viewer: number) {
      return forViewer(activity, viewer);
    }),

    findActivityFile: Effect.fn('ActivitiesService.findActivityFile')(function* (
      ...values: Parameters<ActivitiesRepository['findActivityFile']>
    ) {
      return findActivityFile(...values);
    }),

    insertActivityFile: Effect.fn('ActivitiesService.insertActivityFile')(function* (
      ...values: Parameters<ActivitiesRepository['insertActivityFile']>
    ) {
      return insertActivityFile(...values);
    }),

    findOwnedActivityFile: Effect.fn('ActivitiesService.findOwnedActivityFile')(function* (
      ...values: Parameters<ActivitiesRepository['findOwnedActivityFile']>
    ) {
      return findOwnedActivityFile(...values);
    }),
    /** Reserve the row, write the file durably, then mark the row ready. */
    saveImage: Effect.fn('ActivitiesService.saveImage')(function* (player: number, activity: string, jpg: Uint8Array) {
      return yield* Effect.promise(() => saveImage(player, activity, jpg));
    }),

    insertActivityMedia: Effect.fn('ActivitiesService.insertActivityMedia')(function* (
      ...values: Parameters<ActivitiesRepository['insertActivityMedia']>
    ) {
      return insertActivityMedia(...values);
    }),

    findActivityMedia: Effect.fn('ActivitiesService.findActivityMedia')(function* (
      ...values: Parameters<ActivitiesRepository['findActivityMedia']>
    ) {
      return findActivityMedia(...values);
    }),

    photos: Effect.fn('ActivitiesService.photos')(function* (player: number, activity: bigint) {
      return photos(player, activity);
    }),

    companion: Effect.fn('ActivitiesService.companion')(function* (activity: Activity, details: boolean = false) {
      return companion(activity, details);
    }),
    /** A rider's own activities for the web app. The rider owns them, so fitness privacy does not apply. */
    own: Effect.fn('ActivitiesService.own')(function* (player: number, id?: string, page?: number) {
      return own(player, id, page);
    }),
    ownDetail: Effect.fn('ActivitiesService.ownDetail')(function* (player: number, id: string) {
      return ownDetail(player, id);
    }),
    /** The canonical FIT payload of an own activity, with a filename safe for a download header. */
    ownFit: Effect.fn('ActivitiesService.ownFit')(function* (player: number, id: string) {
      return ownFit(player, id);
    }),
    ownImagePath: Effect.fn('ActivitiesService.ownImagePath')(function* (
      player: number,
      activity: string,
      image: number,
    ) {
      return ownImagePath(player, activity, image);
    }),

    recentActivities: Effect.fn('ActivitiesService.recentActivities')(function* (
      ...values: Parameters<ActivitiesRepository['recentActivities']>
    ) {
      return recentActivities(...values);
    }),

    activityById: Effect.fn('ActivitiesService.activityById')(function* (
      ...values: Parameters<ActivitiesRepository['activityById']>
    ) {
      return activityById(...values);
    }),

    activityFeed: Effect.fn('ActivitiesService.activityFeed')(function* (
      ...values: Parameters<ActivitiesRepository['activityFeed']>
    ) {
      return activityFeed(...values);
    }),

    activityChart: Effect.fn('ActivitiesService.activityChart')(function* (
      ...args: Parameters<typeof FitService.activityChart>
    ) {
      return activityChart(...args);
    }),

    chart: Effect.fn('ActivitiesService.chart')(function* (bytes: Uint8Array) {
      return yield* Effect.promise(() => chartNow(bytes));
    }),

    savePowerCurve: Effect.fn('ActivitiesService.savePowerCurve')(function* (id: number, bytes: Uint8Array) {
      return savePowerCurve(id, bytes);
    }),

    updateStreaks: Effect.fn('ActivitiesService.updateStreaks')(function* (id: number, activity: Activity) {
      return updateStreaks(id, activity);
    }),
    rebuildPowerCurves: Effect.fn('ActivitiesService.rebuildPowerCurves')(function* (player: number) {
      return rebuildPowerCurves(player);
    }),
    chartFile: Effect.fn('ActivitiesService.chartFile')(function* (activity: bigint) {
      return chartFile(activity);
    }),

    chartPath: Effect.fn('ActivitiesService.chartPath')(function* (activity: IntegerInput) {
      return chartPath(activity);
    }),

    exportPath: Effect.fn('ActivitiesService.exportPath')(function* (activity: IntegerInput) {
      return exportPath(activity);
    }),

    folder: Effect.fn('ActivitiesService.folder')(function* (activity: IntegerInput) {
      return folderOf(activity);
    }),
  };
});

export class ActivitiesService extends Context.Service<ActivitiesService, Effect.Success<typeof make>>()(
  'zluggish/ActivitiesService',
) {
  static readonly layer = Layer.effect(ActivitiesService, make);

  static readonly visible = visible;

  static readonly fitnessVisible = fitnessVisible;

  static readonly forViewer = forViewer;

  static readonly withoutFit = withoutFit;
}
