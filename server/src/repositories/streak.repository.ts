import type { Activity } from '#src/protocol/generated/activity_pb';
import { StreaksSchema } from '#src/protocol/generated/profile_pb';
import { writeDurable } from '#src/repositories/files.repository';
import type { Profiles } from '#src/repositories/profile.repository';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function weekRange(time: number) {
  const start = new Date(time);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));

  return { start: start.getTime(), end: start.getTime() + 604_800_000 - 1000 };
}

export function streaksFor(profiles: Profiles, id: number) {
  const path = resolve(profiles.folder(id), 'streaks.bin');

  if (existsSync(path)) return fromBinary(StreaksSchema, readFileSync(path));
  const profile = profiles.get(id);

  return create(StreaksSchema, {
    curStreak: profile.curStreak,
    curStreakDistance: Math.trunc(profile.curStreakDistance),
    curStreakElevation: Math.trunc(profile.curStreakElevation),
    curStreakCalories: Math.trunc(profile.curStreakCalories),
    maxStreak: profile.maxStreak,
    maxStreakDistance: Math.trunc(profile.maxStreakDistance),
    maxStreakElevation: Math.trunc(profile.maxStreakElevation),
    maxStreakCalories: Math.trunc(profile.maxStreakCalories),
    weekEnd: BigInt(weekRange(Number(profile.curStreakRide) * 1000).end),
    curStreakRide: profile.curStreakRide * 1000n,
  });
}

export function updateStreaks(profiles: Profiles, id: number, activity: Activity) {
  const streaks = streaksFor(profiles, id);
  const start = Date.parse(activity.startDate);

  if (!Number.isFinite(start)) return;

  if (start > Number(streaks.weekEnd) + 604_800_000) {
    streaks.curStreak = 1;
    streaks.curStreakRide = BigInt(start);
    streaks.curStreakDistance = 0;
    streaks.curStreakElevation = 0;
    streaks.curStreakCalories = 0;
  } else if (start > Number(streaks.weekEnd)) {
    streaks.curStreak++;
    streaks.curStreakRide = BigInt(start);
  }

  streaks.curStreakDistance += Math.trunc(activity.distanceInMeters);
  streaks.curStreakElevation += Math.trunc(activity.totalElevation);
  streaks.curStreakCalories += Math.trunc(activity.calories);
  streaks.maxStreak = Math.max(streaks.maxStreak, streaks.curStreak);
  streaks.maxStreakDistance = Math.max(streaks.maxStreakDistance, streaks.curStreakDistance);
  streaks.maxStreakElevation = Math.max(streaks.maxStreakElevation, streaks.curStreakElevation);
  streaks.maxStreakCalories = Math.max(streaks.maxStreakCalories, streaks.curStreakCalories);
  streaks.weekEnd = BigInt(weekRange(start).end);
  writeDurable(resolve(profiles.folder(id), 'streaks.bin'), toBinary(StreaksSchema, streaks), true);
}
