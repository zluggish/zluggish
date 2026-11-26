import { t } from '#src/i18n/index';
import { AssetFiles } from '#src/repositories/files.repository';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { dirname, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Schema } from 'effect';

const journalSchema = Schema.NullOr(
  Schema.Struct({
    token: Schema.String,
    files: Schema.Array(Schema.Struct({ path: Schema.String, previous: Schema.NullOr(Schema.String) })),
  }),
);

/** Synchronous publication at existing paths. Recovery must finish before serving any files or listings. */
export class WorkoutPublication {
  private readonly journal: string;

  constructor(
    private readonly db: DatabaseSync,
    private readonly storage: string,
    private readonly files = new AssetFiles(),
  ) {
    this.journal = resolve(storage, 'workout-publication.json');
    db.exec(
      'CREATE TABLE IF NOT EXISTS workout_publication (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL)',
    );
    this.recover();
  }

  recover() {
    if (!this.files.existsSync(this.journal)) {
      return;
    }
    const journal = Schema.decodeUnknownSync(journalSchema)(JSON.parse(this.files.readFileSync(this.journal, 'utf8')));
    if (!journal) {
      return;
    }
    const committed =
      this.db.prepare('SELECT token FROM workout_publication WHERE id = 1').get()?.token === journal.token;
    if (!committed) {
      for (const entry of journal.files) {
        const path = resolve(this.storage, entry.path);
        if (relative(this.storage, path).startsWith('..') || path === resolve(this.storage)) {
          throw new Error(t('invalid_workout_recovery_path'));
        }
        if (entry.previous === null) {
          this.files.rmSync(path, { force: true });
          // Deletion must reach disk before clearing the journal.
          if (this.files.existsSync(dirname(path))) {
            this.files.syncDirectory(dirname(path));
          }
        } else {
          this.files.writeDurable(path, Buffer.from(entry.previous, 'base64'), true);
        }
      }
    }
    // A durable tombstone avoids relying on unlink durability. Recovery is repeatable.
    this.files.writeDurable(this.journal, 'null', true);
  }

  publish(contents: ReadonlyMap<string, string | Uint8Array>, updateListing?: () => void) {
    this.recover();
    const token = new CryptoRepository().randomUUID();
    const files = contents
      .keys()
      .map((path) => {
        const name = relative(this.storage, path);
        if (name.startsWith('..') || name === '') {
          throw new Error(t('invalid_workout_publication_path'));
        }
        return {
          path: name,
          previous: this.files.existsSync(path) ? this.files.readFileSync(path).toString('base64') : null,
        };
      })
      .toArray();
    this.files.writeDurable(this.journal, JSON.stringify({ token, files }), true);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [path, content] of contents) {
        this.files.writeDurable(path, content, true);
      }
      updateListing?.();
      this.db.prepare('INSERT OR REPLACE INTO workout_publication (id, token) VALUES (1, ?)').run(token);
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) {
        this.db.exec('ROLLBACK');
      }
      this.recover();
      throw error;
    }
    this.recover();
  }
}
