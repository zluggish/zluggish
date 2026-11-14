import type { Activity } from '#src/protocol/generated/activity_pb';
import { StreaksSchema } from '#src/protocol/generated/profile_pb';
import type { Profiles } from '#src/repositories/profile.repository';
import { BaseService } from '#src/services/base.service';
import { clone, create } from '@bufbuild/protobuf';

export class StreakService extends BaseService {
  static weekRange(time: number) {
    const start = new Date(time);
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));

    return { start: start.getTime(), end: start.getTime() + 604_800_000 - 1000 };
  }
  streaksFor(profiles: Profiles, id: number) {
    const persisted = this.streakRepository.readStreaks(profiles.folder(id));

    if (persisted) return persisted;
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
      weekEnd: BigInt(StreakService.weekRange(Number(profile.curStreakRide) * 1000).end),
      curStreakRide: profile.curStreakRide * 1000n,
    });
  }
  updateStreaks(profiles: Profiles, id: number, activity: Activity) {
    const streaks = StreakService.advancedStreak(this.streaksFor(profiles, id), activity);
    this.streakRepository.saveStreaks(profiles.folder(id), streaks);
  }
  /** Invalid dates are ignored; older dates retain the existing same-week behavior. */
  static period(start: number, boundary: number) {
    if (!Number.isFinite(start)) return 'invalid';

    if (start > boundary + 604_800_000) return 'gap';

    return start > boundary ? 'next-week' : 'same-week';
  }

  static advancedStreak(previous: ReturnType<StreakService['streaksFor']>, activity: Activity) {
    const streaks = clone(StreaksSchema, previous);
    const start = Date.parse(activity.startDate);

    const period = StreakService.period(start, Number(streaks.weekEnd));

    if (period === 'invalid') return streaks;

    if (period === 'gap') {
      streaks.curStreak = 1;
      streaks.curStreakRide = BigInt(start);
      streaks.curStreakDistance = 0;
      streaks.curStreakElevation = 0;
      streaks.curStreakCalories = 0;
    } else if (period === 'next-week') {
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
    streaks.weekEnd = BigInt(StreakService.weekRange(start).end);

    return streaks;
  }
}
