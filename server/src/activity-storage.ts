import { resolve } from 'node:path';

/** One folder per activity in the rider folder:

  <rider>/activities/2026-11-22T223716Z_33/activity.fit
                                          chart.json
                                          images/<image id>.jpg
                                          videos/<media id>.mp4|mov
  <rider>/activities/orphaned/             files the activity-folder migration could not match

The folder name is the activity start in UTC followed by the activity id, so a listing
sorts by time. It is assigned once (activity.storage_dir) and never changes.
*/
export const ActivityStorage = {
  Directory: 'activities',
  Orphaned: 'orphaned',
  Fit: 'activity.fit',
  Chart: 'chart.json',
  Images: 'images',
  Videos: 'videos',
} as const;

export const activityDirectoryPattern = /^\d{4}-\d{2}-\d{2}T\d{6}Z_(\d+)$/;

const latest = Date.UTC(9999, 11, 31, 23, 59, 59);

function timestamp(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);

  return Number.isFinite(parsed) && parsed >= 0 && parsed <= latest ? parsed : null;
}

/** The folder name of an activity: the first usable date (start, then date, then end),
else `fallback`.
*/
export function activityDirectoryName(
  id: number | bigint,
  dates: ReadonlyArray<string | null | undefined>,
  fallback = Date.now(),
) {
  const iso = new Date(dates.map((date) => timestamp(date)).find((value) => value !== null) ?? fallback).toISOString();

  return `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z_${id}`;
}

export function activitiesFolder(rider: string) {
  return resolve(rider, ActivityStorage.Directory);
}

export function activityFolder(rider: string, directory: string) {
  return resolve(rider, ActivityStorage.Directory, directory);
}

export function videoExtension(contentType: string) {
  return contentType.includes('quicktime') ? 'mov' : 'mp4';
}

export function imagePath(activity: string, id: number | bigint) {
  return resolve(activity, ActivityStorage.Images, `${id}.jpg`);
}

export function videoPath(activity: string, id: number | bigint, contentType: string) {
  return resolve(activity, ActivityStorage.Videos, `${id}.${videoExtension(contentType)}`);
}
