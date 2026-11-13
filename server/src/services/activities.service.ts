import { log } from '#src/logging';
import { Completions } from '#src/repositories/completion.repository';
import { ProtobufRows } from '#src/repositories/protobuf.repository';
import { ActivityUploads } from '#src/repositories/uploads.repository';
import { resolveRiderSettings } from '#src/repositories/settings.repository';
import { GhostSchema, WorldAttributeSchema, WA_TYPE } from '#src/protocol/generated/udp-node-msgs_pb';
import { course, worldTime } from '#src/world/state';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { type RepositoryContext } from '#src/context';
import { ApplicationError } from '#src/errors';
import { ActivityPrivacyType, Sport, StreaksSchema } from '#src/protocol/generated/profile_pb';
import { FitnessPrivacy } from '#src/protocol/generated/activity_pb';
import { ActivitySchema, type Activity } from '#src/protocol/generated/activity_pb';
import { ActivitiesRepository } from '#src/repositories/activities.repository';
import { existsSync, readdirSync, rmSync, writeDurable } from '#src/repositories/files.repository';
import { activityChart, savePowerCurve } from '#src/repositories/fit.repository';
import { advancedStreak, streaksFor, updateStreaks } from '#src/repositories/streak.repository';
import { resolve } from 'node:path';
import { z } from 'zod';

export class ActivitiesService {
  constructor(
    private readonly repository: ActivitiesRepository,
    private readonly context: RepositoryContext,
  ) {}

  finalized(activity: Activity) {
    const saved = new Completions(this.context.accounts.db).get(activity.id);

    if (!saved) return false;

    if (!Buffer.from(saved.payload).equals(Buffer.from(toBinary(ActivitySchema, activity))))
      throw new ApplicationError(409, 'Completed activities cannot be replaced.');

    return saved.done !== 0;
  }

  recover() {
    for (const row of new Completions(this.context.accounts.db).unfinished())
      this.finalize(fromBinary(ActivitySchema, row.payload));
  }

  finalize(activity: Activity) {
    if (this.finalized(activity)) return;
    const player = Number(activity.playerId);
    const journal = new Completions(this.context.accounts.db);
    const folder = this.context.profiles.folder(player);

    if (!journal.get(activity.id)) {
      // Finish earlier writes before deriving another snapshot of this rider's progression.
      for (const pending of journal.unfinished())
        if (pending.player_id === player) this.finalize(fromBinary(ActivitySchema, pending.payload));

      const streak =
        activity.sport === Sport.CYCLING && activity.distanceInMeters >= 2000
          ? toBinary(StreaksSchema, advancedStreak(streaksFor(this.context.profiles, player), activity))
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

    writeDurable(resolve(folder, 'fit', `${activity.id} - ${name}`), activity.fit, true);
    writeDurable(resolve(folder, 'last_activity.bin'), saved.payload, true);

    if (saved.streak) writeDurable(resolve(folder, 'streaks.bin'), saved.streak, true);
    const history = this.context.world.histories.get(activity.playerId) ?? [];
    const state = history.at(-1);

    if (
      state &&
      resolveRiderSettings(this.context.config.riderDefaults, this.context.settings.read(player)).ghosts.enabled
    )
      writeDurable(
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
    journal.complete(activity.id, new ActivityUploads(this.context).configured(player), () => {
      new ProtobufRows(this.context.accounts.db).update('activity', activity.id, ActivitySchema, activity, ['fit']);

      try {
        this.savePowerCurve(player, activity.fit);
      } catch {
        log.warn(`Power curve unavailable for activity ${activity.id}`);
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
    return this.repository.findActivity(...values);
  }
  deleteActivity(id: bigint, player: number) {
    if (!this.repository.findActivity(id, player)) throw new ApplicationError(404);

    const charts = this.repository
      .listActivityFile(id)
      .map((row) => resolve(this.context.config.storageDir, 'activities', String(z.number().parse(row.id))));

    const photos = this.photos(player, id);
    const fitFolder = resolve(this.context.profiles.folder(player), 'fit');

    const fits = existsSync(fitFolder)
      ? readdirSync(fitFolder)
          .filter((name) => name.startsWith(`${id} - `))
          .map((name) => resolve(fitFolder, name))
      : [];

    this.repository.deleteActivityData(id, player);

    for (const file of [...charts, ...photos, ...fits]) rmSync(file, { force: true });
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
    return this.repository.findActivityFile(...values);
  }
  insertActivityFile(...values: Parameters<ActivitiesRepository['insertActivityFile']>) {
    return this.repository.insertActivityFile(...values);
  }
  findOwnedActivityFile(...values: Parameters<ActivitiesRepository['findOwnedActivityFile']>) {
    return this.repository.findOwnedActivityFile(...values);
  }
  insertActivityImage(...values: Parameters<ActivitiesRepository['insertActivityImage']>) {
    return this.repository.insertActivityImage(...values);
  }
  insertActivityMedia(...values: Parameters<ActivitiesRepository['insertActivityMedia']>) {
    return this.repository.insertActivityMedia(...values);
  }
  findActivityMedia(...values: Parameters<ActivitiesRepository['findActivityMedia']>) {
    return this.repository.findActivityMedia(...values);
  }

  photos(player: number, activity: bigint) {
    const folder = this.context.profiles.folder(player);

    const images = z
      .array(z.object({ id: z.number() }))
      .parse(this.repository.listActivityImage(player, activity))
      .map((row) => resolve(folder, 'images', `${row.id}.jpg`));

    const media = z
      .array(z.object({ id: z.number(), content_type: z.string() }))
      .parse(this.repository.listActivityMedia(player, activity))
      .map((row) => resolve(folder, 'medias', `${row.id}.${row.content_type.includes('quicktime') ? 'mov' : 'mp4'}`));

    return [...images, ...media].filter((path) => existsSync(path));
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
    return this.repository.recentActivities(...values);
  }

  activityById(...values: Parameters<ActivitiesRepository['activityById']>) {
    return this.repository.activityById(...values);
  }

  activityFeed(...values: Parameters<ActivitiesRepository['activityFeed']>) {
    return this.repository.activityFeed(...values);
  }

  activityChart(...args: Parameters<typeof activityChart>) {
    return activityChart(...args);
  }

  savePowerCurve(id: number, bytes: Uint8Array) {
    return savePowerCurve(this.context.accounts, this.context.profiles, id, bytes);
  }

  updateStreaks(id: number, activity: Activity) {
    return updateStreaks(this.context.profiles, id, activity);
  }
}
