import { t } from '#src/i18n/index';
import { decodeOwned } from '#src/schema';
import { FitQueueFullError } from '#src/errors';
import type { ActivityChart, PowerBests } from '#src/repositories/fit-decoder.repository';
import { Metric, metrics } from '#src/repositories/metrics.repository';
import { Worker } from 'node:worker_threads';
import { Schema } from 'effect';

type Task = 'chart' | 'powerBests';

type Json = typeof Schema.Json.Type;

type Pending = { resolve: (value: Json) => void; reject: (error: Error) => void };

const response = Schema.Struct({
  id: Schema.Finite,
  duration: Schema.Finite,
  error: Schema.optional(Schema.String),
  result: Schema.optional(Schema.Json),
});

const chartSchema = Schema.Struct({
  powerInWatts: Schema.Array(Schema.Finite),
  cadencePerMin: Schema.Array(Schema.Finite),
  heartRate: Schema.Array(Schema.Finite),
  distanceInCm: Schema.Array(Schema.Finite),
  speedInCmPerSec: Schema.Array(Schema.Finite),
  timeInSec: Schema.Array(Schema.Finite),
  altitudeInCm: Schema.Array(Schema.Finite),
  latlng: Schema.Array(Schema.Array(Schema.Finite)),
});

const bestsSchema = Schema.Struct({
  timestamp: Schema.Finite,
  bests: Schema.Array(Schema.Struct({ time: Schema.Finite, power: Schema.Finite })),
});

/** One FIT worker thread with a bounded queue of pending tasks. The worker starts
on first use and does not keep the process alive.
*/
export class FitRepository {
  private worker: Worker | null = null;

  private next = 0;

  private readonly pending = new Map<number, Pending>();

  constructor(readonly limit = 32) {}

  get queued() {
    return this.pending.size;
  }

  async chart(bytes: Uint8Array): Promise<ActivityChart> {
    return decodeOwned(chartSchema)(await this.run('chart', bytes));
  }

  async powerBests(bytes: Uint8Array): Promise<PowerBests> {
    return decodeOwned(bestsSchema)(await this.run('powerBests', bytes));
  }

  private run(task: Task, bytes: Uint8Array): Promise<Json> {
    if (this.pending.size >= this.limit) {
      metrics.record(Metric.QueueRejected, 1);

      return Promise.reject(new FitQueueFullError());
    }

    metrics.record(Metric.QueueDepth, this.pending.size + 1);
    const worker = this.start();
    const id = this.next++;

    // The caller keeps the canonical payload. Copy it into a dedicated buffer and
    // transfer that buffer, so the worker owns it without a second copy.
    const copy = metrics.time(Metric.FitCopy, () => new Uint8Array(bytes));
    const result = Promise.withResolvers<Json>();
    this.pending.set(id, { resolve: result.resolve, reject: result.reject });
    worker.ref();
    worker.postMessage({ id, task, bytes: copy }, [copy.buffer]);

    return result.promise;
  }

  private start() {
    if (this.worker) {
      return this.worker;
    }
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const worker = new Worker(new URL(`fit.worker.${extension}`, import.meta.url));
    worker.unref();

    worker.on('message', (message) => {
      const parsed = Schema.decodeUnknownSync(response)(message);
      const pending = this.pending.get(parsed.id);
      this.pending.delete(parsed.id);
      metrics.record(Metric.FitProcessing, parsed.duration);

      if (this.pending.size === 0) {
        worker.unref();
      }

      if (!pending) {
        return;
      }

      if (parsed.error === undefined) {
        pending.resolve(parsed.result ?? null);
      } else {
        pending.reject(new Error(parsed.error));
      }
    });

    worker.on('error', (error) => this.fail(error instanceof Error ? error : new Error(t('fit_worker_failed'))));
    worker.on('exit', () => this.fail(new Error(t('fit_worker_stopped'))));
    this.worker = worker;

    return worker;
  }

  private fail(error: Error) {
    this.worker = null;

    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close() {
    const worker = this.worker;
    this.worker = null;
    await worker?.terminate();
  }
}

/** Process-wide pool: FIT processing is CPU work shared by all runtimes. */
export const fitWorkers = new FitRepository();
