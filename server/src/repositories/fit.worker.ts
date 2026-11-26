import { t } from '#src/i18n/index';
import { FitDecoder } from '#src/repositories/fit-decoder.repository';
import { parentPort } from 'node:worker_threads';
import { Schema } from 'effect';

const request = Schema.Struct({
  id: Schema.Finite,
  task: Schema.Literals(['chart', 'powerBests']),
  bytes: Schema.instanceOf(Uint8Array),
});

const decoder = new FitDecoder();

parentPort?.on('message', (message) => {
  const { id, task, bytes } = Schema.decodeUnknownSync(request)(message);
  const start = performance.now();

  try {
    const result = task === 'chart' ? decoder.chart(bytes) : decoder.powerBests(bytes);
    parentPort?.postMessage({ id, result, duration: performance.now() - start });
  } catch {
    parentPort?.postMessage({ id, error: t('invalid_fit_activity'), duration: performance.now() - start });
  }
});
