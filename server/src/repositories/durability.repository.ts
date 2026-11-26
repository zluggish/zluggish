import { Metric, metrics } from '#src/repositories/metrics.repository';
import { open } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { Schema } from 'effect';

/** Commits on the main connection use synchronous=NORMAL while this barrier runs: they
write the WAL without a flush on the main thread. flush() makes every earlier commit
durable by flushing the WAL file on the libuv thread pool (F_FULLFSYNC on macOS).
Wait for it before acknowledging a save, or before a request that depends on a
committed state. Concurrent callers share one flush.
*/
export class DurabilityRepository {
  private active = false;

  private current: Promise<void> | null = null;

  private next: Promise<void> | null = null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly path: string,
  ) {}

  start() {
    this.db.exec('PRAGMA synchronous=NORMAL');
    this.active = true;
  }

  changes() {
    return Schema.decodeUnknownSync(Schema.Finite)(this.db.prepare('SELECT total_changes() AS n').get()?.n);
  }

  /** Resolves when every commit made before the call is durable. */
  flush(): Promise<void> {
    if (!this.active) {
      return Promise.resolve();
    }

    // A running flush may have started before the caller's commit: queue one more,
    // shared by every caller that arrives while it runs.
    if (this.current) {
      // A catch would also handle the recursive flush and could clear its newer queue.
      // eslint-disable-next-line unicorn/prefer-then-catch
      this.next ??= this.current.then(
        () => {
          this.next = null;

          return this.flush();
        },
        (error: unknown) => {
          this.next = null;
          throw error;
        },
      );

      return this.next;
    }

    this.current = metrics
      .timeAsync(Metric.Flush, () => this.sync())
      .finally(() => {
        this.current = null;
      });

    return this.current;
  }

  private async sync() {
    let handle;

    try {
      handle = await open(`${this.path}-wal`, 'r+');
    } catch (error) {
      // No WAL file: no commit waits for a flush.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }

    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Back to a flush at each commit, for shutdown and offline work. */
  async close() {
    if (!this.active) {
      return;
    }
    await this.flush();
    this.active = false;

    if (this.db.isOpen) {
      this.db.exec('PRAGMA synchronous=FULL');
    }
  }
}
