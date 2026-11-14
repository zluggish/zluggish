import type { RepositoryContext as Runtime } from '#src/context';
import { AchievementEntrySchema, AchievementsSchema } from '#src/protocol/generated/profile_pb';
import { BaseService } from '#src/services/base.service';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { resolve } from 'node:path';
import { z } from 'zod';

/** Per rider, missing file bootstraps saved-game unlocks; membership only grows through
threshold/report events. Import replaces this state externally; reads may backfill routes.
*/
export class AchievementService extends BaseService {
  loadAchievements(runtime: Runtime, id: number) {
    const file = resolve(runtime.profiles.folder(id), 'achievements.bin');
    const exists = this.filesRepository.existsSync(file);

    const achievements = exists
      ? fromBinary(AchievementsSchema, this.filesRepository.readFileSync(file))
      : create(AchievementsSchema);

    let changed = !exists;

    if (!exists) {
      const saved = runtime.profiles.get(id).savedGame;

      if (saved.length > 0x1_50 && saved[0x1_08] === 2) {
        const bits = saved.subarray(0x1_10, 0x1_50);

        for (let badge = 0; badge < bits.length * 8; badge++)
          if (((bits[Math.floor(badge / 8)] ?? 0) >> badge % 8) & 1)
            achievements.achievements.push(create(AchievementEntrySchema, { id: badge }));
      }
    }

    const count = this.recordsRepository.routeBadgeCount(id);

    for (const [minimum, badge] of [
      [1, 211],
      [10, 212],
      [25, 213],
    ] as const)
      if (count >= minimum && achievements.achievements.every((item) => item.id !== badge)) {
        achievements.achievements.push(create(AchievementEntrySchema, { id: badge }));
        changed = true;
      }

    if (changed) this.filesRepository.writeDurable(file, toBinary(AchievementsSchema, achievements), true);

    return achievements;
  }
  backfillRoutes(runtime: Runtime, id: number) {
    const achievements = this.loadAchievements(runtime, id);

    const dictionary = z
      .object({ achievements: z.record(z.string(), z.number().int()) })
      .parse(
        JSON.parse(this.filesRepository.readFileSync(resolve(runtime.assets, 'data/game_dictionary.txt'), 'utf8')),
      );

    const db = runtime.accounts.db;
    db.exec('BEGIN IMMEDIATE');

    try {
      const repository = this.recordsRepository;

      for (const badge of achievements.achievements) {
        const hash = dictionary.achievements[String(badge.id)];

        if (hash !== undefined) repository.ensureRoute(id, hash);
      }

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
