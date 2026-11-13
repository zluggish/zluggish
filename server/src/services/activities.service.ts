import { type RepositoryContext } from '#src/context';
import { ApplicationError } from '#src/errors';
import { ActivityPrivacyType } from '#src/protocol/generated/profile_pb';
import { FitnessPrivacy } from '#src/protocol/generated/activity_pb';
import { type Activity } from '#src/protocol/generated/activity_pb';
import { ActivitiesRepository } from '#src/repositories/activities.repository';
import { existsSync, readdirSync, rmSync } from '#src/repositories/files.repository';
import { activityChart, savePowerCurve } from '#src/repositories/fit.repository';
import { updateStreaks } from '#src/repositories/streak.repository';
import { resolve } from 'node:path';
import { z } from 'zod';

export class ActivitiesService {
  constructor(
    private readonly repository: ActivitiesRepository,
    private readonly context: RepositoryContext,
  ) {}

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
