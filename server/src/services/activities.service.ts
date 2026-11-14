import { activityMediaSchema } from '#src/dtos/activities.dto';
import { type RepositoryContext } from '#src/context';
import { ApplicationError } from '#src/errors';
import { ActivitySchema, FitnessPrivacy, type Activity } from '#src/protocol/generated/activity_pb';
import { ActivityPrivacyType, Sport, StreaksSchema } from '#src/protocol/generated/profile_pb';
import { GhostSchema, WA_TYPE, WorldAttributeSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { ActivitiesRepository } from '#src/repositories/activities.repository';
import { BaseService } from '#src/services/base.service';
import { FitService } from '#src/services/fit.service';
import { SettingsService } from '#src/services/settings.service';
import { StreakService } from '#src/services/streak.service';
import { UploadsService } from '#src/services/uploads.service';
import { course, worldTime } from '#src/world/state';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { resolve } from 'node:path';
import { z } from 'zod';

export class ActivitiesService extends BaseService {
  private readonly mediaTokens = new Map<string, { token: Buffer; expires: number; status: 'issued' | 'receiving' }>();

  issueMedia(id: string) {
    for (const [key, entry] of this.mediaTokens) if (entry.expires < Date.now()) this.mediaTokens.delete(key);

    const entry = {
      token: this.cryptoRepository.randomBytes(32),
      expires: Date.now() + 900_000,
      status: 'issued' as const,
    };

    this.mediaTokens.set(id, entry);

    return entry;
  }

  /** issued -> receiving -> consumed; a failed write releases the claim for retry.
  Validate again after reading the body: deleting the activity must not recreate its media.
  */
  async receiveMedia(id: string, token: Buffer, read: () => Promise<ArrayBuffer>) {
    const entry = this.mediaTokens.get(id);

    if (
      !entry ||
      entry.status !== 'issued' ||
      entry.expires < Date.now() ||
      token.length !== entry.token.length ||
      !this.cryptoRepository.timingSafeEqual(token, entry.token)
    )
      throw new ApplicationError(403);
    entry.status = 'receiving';

    try {
      if (!this.activitiesRepository.findActivityMedia(id)) throw new ApplicationError(404);
      const bytes = new Uint8Array(await read());

      if (this.mediaTokens.get(id) !== entry || entry.expires < Date.now()) throw new ApplicationError(403);
      const row = activityMediaSchema.safeParse(this.activitiesRepository.findActivityMedia(id));

      if (!row.success) throw new ApplicationError(404);
      const extension = row.data.content_type.includes('quicktime') ? 'mov' : 'mp4';
      this.filesRepository.write(
        resolve(this.context.profiles.folder(row.data.player_id), 'medias', `${id}.${extension}`),
        bytes,
      );
      this.mediaTokens.delete(id);
    } catch (error) {
      if (this.mediaTokens.get(id) === entry) entry.status = 'issued';
      throw error;
    }
  }

  constructor(private readonly context: RepositoryContext) {
    super(context.accounts.repositories);
  }

  finalized(activity: Activity) {
    const state = this.completionRepository.state(activity.id);

    if (state.status === 'draft') return false;
    const { saved } = state;

    if (!Buffer.from(saved.payload).equals(Buffer.from(toBinary(ActivitySchema, activity))))
      throw new ApplicationError(409, 'Completed activities cannot be replaced.');

    return state.status === 'completed';
  }

  /** Draft edits, durable completion and discard are distinct from ending a ride. */
  save(activity: Activity, finish: boolean) {
    if (this.finalized(activity)) return 'unchanged';

    if (!finish) {
      this.protobufRepository.update('activity', activity.id, ActivitySchema, activity, ['fit']);

      return 'updated';
    }

    if (activity.distanceInMeters < 1) {
      this.deleteActivity(activity.id, Number(activity.playerId));
      this.context.world.lifecycle.log.info('activity.discarded', 'Activity discarded', {
        playerId: Number(activity.playerId),
        activityId: activity.id,
      });

      return 'discarded';
    }

    this.finalize(activity);

    return 'completed';
  }

  recover() {
    for (const row of this.completionRepository.unfinished())
      this.finalize(fromBinary(ActivitySchema, row.payload), true);
  }

  finalize(activity: Activity, recovery = false) {
    if (this.finalized(activity)) return;

    try {
      this.complete(activity);
    } catch (error) {
      this.context.world.lifecycle.log.error('activity.save_failed', 'Activity save failed', {
        playerId: activity.playerId,
        activityId: activity.id,
        recoverable: true,
        error: error instanceof Error ? error : undefined,
      });
      throw error;
    }

    this.context.world.lifecycle.log.info('activity.saved', 'Activity saved', {
      playerId: activity.playerId,
      activityId: activity.id,
      recovery,
    });
  }

  private complete(activity: Activity) {
    if (this.finalized(activity)) return;
    const player = Number(activity.playerId);
    const journal = this.completionRepository;
    const folder = this.context.profiles.folder(player);

    if (journal.state(activity.id).status === 'draft') {
      // Finish earlier writes before deriving another snapshot of this rider's progression.
      for (const pending of journal.unfinished())
        if (pending.player_id === player) this.finalize(fromBinary(ActivitySchema, pending.payload));

      const streak =
        activity.sport === Sport.CYCLING && activity.distanceInMeters >= 2000
          ? toBinary(
              StreaksSchema,
              StreakService.advancedStreak(
                new StreakService(this.repositories).streaksFor(this.context.profiles, player),
                activity,
              ),
            )
          : null;

      journal.prepare(activity.id, player, toBinary(ActivitySchema, activity), streak);
    }

    const saved = journal.get(activity.id);

    if (!saved) throw new Error('Missing activity completion journal');

    const name =
      activity.fitFilename
        .normalize('NFKD')
        .replaceAll(/[^\w. -]/g, '_')
        .replace(/^\.+/, '') || 'activity.fit';

    this.filesRepository.writeDurable(resolve(folder, 'fit', `${activity.id} - ${name}`), activity.fit, true);
    this.filesRepository.writeDurable(resolve(folder, 'last_activity.bin'), saved.payload, true);

    if (saved.streak) this.filesRepository.writeDurable(resolve(folder, 'streaks.bin'), saved.streak, true);
    const history = this.context.world.histories.get(activity.playerId) ?? [];
    const state = history.at(-1);

    if (
      state &&
      SettingsService.resolveRiderSettings(this.context.config.riderDefaults, this.context.settings.read(player)).ghosts
        .enabled
    )
      this.filesRepository.writeDurable(
        resolve(
          folder,
          'ghosts',
          String(course(state)),
          ...(state.route
            ? [String(state.route)]
            : [String((state.aux3 >>> 8) & 0xff_ff), ...(state.f19 & 4 ? [] : ['reverse'])]),
          `activity-${activity.id}.bin`,
        ),
        toBinary(GhostSchema, create(GhostSchema, { playerId: player, states: history })),
        true,
      );
    journal.complete(activity.id, new UploadsService(this.context).configured(player), () => {
      this.protobufRepository.update('activity', activity.id, ActivitySchema, activity, ['fit']);

      try {
        this.savePowerCurve(player, activity.fit);
      } catch {
        this.context.world.lifecycle.log.warn('activity.power_curve_unavailable', 'Power curve unavailable', {
          activityId: activity.id,
          playerId: activity.playerId,
        });
      }
    });

    if (saved.streak)
      this.context.world.enqueue(
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

  findActivity(...values: Parameters<ActivitiesRepository['findActivity']>) {
    return this.activitiesRepository.findActivity(...values);
  }

  deleteActivity(id: bigint, player: number) {
    if (!this.activitiesRepository.findActivity(id, player)) throw new ApplicationError(404);

    const charts = this.activitiesRepository
      .listActivityFile(id)
      .map((row) => resolve(this.context.config.storageDir, 'activities', String(z.number().parse(row.id))));

    const photos = this.photos(player, id);
    const fitFolder = resolve(this.context.profiles.folder(player), 'fit');

    const fits = this.filesRepository.existsSync(fitFolder)
      ? this.filesRepository
          .readdirSync(fitFolder)
          .filter((name) => name.startsWith(`${id} - `))
          .map((name) => resolve(fitFolder, name))
      : [];

    this.activitiesRepository.deleteActivityData(id, player);

    for (const file of [...charts, ...photos, ...fits]) this.filesRepository.rmSync(file, { force: true });
  }

  visible(activity: Activity, viewer: number) {
    return (
      activity.playerId === BigInt(viewer) ||
      (!activity.privateActivity && activity.privacy === ActivityPrivacyType.PUBLIC)
    );
  }

  fitnessVisible(activity: Activity, viewer: number) {
    return (
      this.visible(activity, viewer) &&
      (activity.playerId === BigInt(viewer) || activity.fitnessPrivacy !== FitnessPrivacy.HIDE_SENSITIVE_DATA)
    );
  }

  forViewer(activity: Activity, viewer: number) {
    if (!this.visible(activity, viewer)) throw new ApplicationError(404);

    if (this.fitnessVisible(activity, viewer)) return activity;

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

  findActivityFile(...values: Parameters<ActivitiesRepository['findActivityFile']>) {
    return this.activitiesRepository.findActivityFile(...values);
  }

  insertActivityFile(...values: Parameters<ActivitiesRepository['insertActivityFile']>) {
    return this.activitiesRepository.insertActivityFile(...values);
  }

  findOwnedActivityFile(...values: Parameters<ActivitiesRepository['findOwnedActivityFile']>) {
    return this.activitiesRepository.findOwnedActivityFile(...values);
  }

  insertActivityImage(...values: Parameters<ActivitiesRepository['insertActivityImage']>) {
    return this.activitiesRepository.insertActivityImage(...values);
  }

  insertActivityMedia(...values: Parameters<ActivitiesRepository['insertActivityMedia']>) {
    return this.activitiesRepository.insertActivityMedia(...values);
  }

  findActivityMedia(...values: Parameters<ActivitiesRepository['findActivityMedia']>) {
    return this.activitiesRepository.findActivityMedia(...values);
  }

  photos(player: number, activity: bigint) {
    const folder = this.context.profiles.folder(player);

    const images = z
      .array(z.object({ id: z.number() }))
      .parse(this.activitiesRepository.listActivityImage(player, activity))
      .map((row) => resolve(folder, 'images', `${row.id}.jpg`));

    const media = z
      .array(z.object({ id: z.number(), content_type: z.string() }))
      .parse(this.activitiesRepository.listActivityMedia(player, activity))
      .map((row) => resolve(folder, 'medias', `${row.id}.${row.content_type.includes('quicktime') ? 'mov' : 'mp4'}`));

    return [...images, ...media].filter((path) => this.filesRepository.existsSync(path));
  }

  companion(activity: Activity, details = false) {
    const profile = this.context.profiles.get(Number(activity.playerId));

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

  recentActivities(...values: Parameters<ActivitiesRepository['recentActivities']>) {
    return this.activitiesRepository.recentActivities(...values);
  }

  activityById(...values: Parameters<ActivitiesRepository['activityById']>) {
    return this.activitiesRepository.activityById(...values);
  }

  activityFeed(...values: Parameters<ActivitiesRepository['activityFeed']>) {
    return this.activitiesRepository.activityFeed(...values);
  }

  activityChart(...args: Parameters<typeof FitService.activityChart>) {
    return FitService.activityChart(...args);
  }

  savePowerCurve(id: number, bytes: Uint8Array) {
    return new FitService(this.repositories).savePowerCurve(id, bytes);
  }

  updateStreaks(id: number, activity: Activity) {
    return new StreakService(this.repositories).updateStreaks(this.context.profiles, id, activity);
  }
}
