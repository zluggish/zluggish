import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export const completionSchemaSQL = `
CREATE TABLE IF NOT EXISTS activity_completion (
 activity_id INTEGER PRIMARY KEY, player_id INTEGER NOT NULL, payload BLOB NOT NULL,
 streak BLOB, done INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS activity_upload (
 activity_id INTEGER NOT NULL, provider TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
 PRIMARY KEY(activity_id, provider)
);`;

const completion = z.object({
  activity_id: z.number(),
  player_id: z.number(),
  payload: z.instanceof(Uint8Array),
  streak: z.instanceof(Uint8Array).nullable(),
  done: z.number(),
});

export class Completions {
  constructor(readonly db: DatabaseSync) {}
  get(id: bigint) {
    const row = this.db.prepare('SELECT * FROM activity_completion WHERE activity_id=?').get(id);

    return row ? completion.parse(row) : null;
  }
  prepare(id: bigint, player: number, payload: Uint8Array, streak: Uint8Array | null) {
    this.db
      .prepare('INSERT INTO activity_completion (activity_id,player_id,payload,streak) VALUES (?,?,?,?)')
      .run(id, player, payload, streak);
  }
  unfinished() {
    return this.db
      .prepare('SELECT * FROM activity_completion WHERE done=0 ORDER BY activity_id')
      .all()
      .map((row) => completion.parse(row));
  }
  complete(id: bigint, providers: string[], save: () => void) {
    this.db.exec('BEGIN IMMEDIATE');

    try {
      save();

      for (const provider of providers)
        this.db.prepare('INSERT OR IGNORE INTO activity_upload (activity_id,provider) VALUES (?,?)').run(id, provider);
      this.db.prepare('UPDATE activity_completion SET done=1 WHERE activity_id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
