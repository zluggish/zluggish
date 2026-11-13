import type { RepositoryContext as Runtime } from '#src/context';
import { AchievementEntrySchema, AchievementsSchema } from '#src/protocol/generated/profile_pb';
import { writeDurable } from '#src/repositories/files.repository';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

export function loadAchievements(runtime: Runtime, id: number) {
  const file = resolve(runtime.profiles.folder(id), 'achievements.bin');
  const exists = existsSync(file);
  const achievements = exists ? fromBinary(AchievementsSchema, readFileSync(file)) : create(AchievementsSchema);
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

  const { count } = z
    .object({ count: z.number() })
    .parse(
      runtime.accounts.db
        .prepare('SELECT COUNT(*) AS count FROM route_result WHERE player_id=? AND route_hash BETWEEN 10000 AND 11000')
        .get(id),
    );

  for (const [minimum, badge] of [
    [1, 211],
    [10, 212],
    [25, 213],
  ] as const)
    if (count >= minimum && achievements.achievements.every((item) => item.id !== badge)) {
      achievements.achievements.push(create(AchievementEntrySchema, { id: badge }));
      changed = true;
    }

  if (changed) writeDurable(file, toBinary(AchievementsSchema, achievements), true);

  return achievements;
}

export function backfillRoutes(runtime: Runtime, id: number) {
  const achievements = loadAchievements(runtime, id);

  const dictionary = z
    .object({ achievements: z.record(z.string(), z.number().int()) })
    .parse(JSON.parse(readFileSync(resolve(runtime.assets, 'data/game_dictionary.txt'), 'utf8')));

  const db = runtime.accounts.db;
  db.exec('BEGIN IMMEDIATE');

  try {
    const insert = db.prepare(
      'INSERT INTO route_result (player_id,route_hash) SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM route_result WHERE player_id=? AND route_hash=?)',
    );

    for (const badge of achievements.achievements) {
      const hash = dictionary.achievements[String(badge.id)];

      if (hash !== undefined) insert.run(id, hash, id, hash);
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
