import { t } from '#src/i18n/index';
import { JobError } from '#src/errors';
import { Schema } from 'effect';
import { Worker } from 'node:worker_threads';

export const snapshotRequest = Schema.Struct({
  storage: Schema.String,
  config: Schema.NullOr(Schema.String),
  snapshot: Schema.String,
});

export const snapshotResult = Schema.Union([
  Schema.Struct({ type: Schema.Literal('done') }),
  Schema.Struct({ type: Schema.Literal('failed'), message: Schema.String }),
]);

/** One worker per attempt. Its exit is the barrier before the stage can be reused or removed. */
export class BackupSnapshotWorker {
  async run(request: typeof snapshotRequest.Type, signal: AbortSignal) {
    signal.throwIfAborted();

    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';

    const worker = new Worker(new URL(`backup-snapshot.worker.${extension}`, import.meta.url), {
      workerData: request,
    });

    let result: typeof snapshotResult.Type | undefined;
    let failure: Error | undefined;
    let stop: NodeJS.Timeout | undefined;

    function cancel() {
      worker.postMessage('cancel');
      stop = setTimeout(() => void worker.terminate(), 1000);
    }

    worker.on('message', (message) => {
      const decoded = Schema.decodeUnknownOption(snapshotResult)(message);

      if (decoded._tag === 'Some') {
        result = decoded.value;
      }
    });
    worker.on('error', (error) => {
      failure = error instanceof Error ? error : new Error(t('backup_worker_failed'), { cause: error });
    });
    const exited = new Promise<number>((resolve) => {
      worker.once('exit', resolve);
    });

    signal.addEventListener('abort', cancel, { once: true });

    try {
      const code = await exited;
      signal.throwIfAborted();

      if (failure !== undefined) {
        throw failure;
      }

      if (result?.type === 'failed') {
        throw new Error(result.message);
      }

      if (code !== 0 || result?.type !== 'done') {
        throw new JobError({ code: 'backup_worker_exit' });
      }
    } finally {
      clearTimeout(stop);
      signal.removeEventListener('abort', cancel);
    }
  }
}
