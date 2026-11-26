import { t } from '#src/i18n/index';
import { stageBackup } from '#src/migrations/backup';
import { snapshotRequest } from '#src/migrations/backup-snapshot-worker';
import { Schema } from 'effect';
import { parentPort, workerData } from 'node:worker_threads';

const port = parentPort;

if (!port) {
  throw new Error(t('backup_snapshot_worker_worker_required'));
}

const { storage, config, snapshot } = Schema.decodeUnknownSync(snapshotRequest)(workerData);
const controller = new AbortController();

port.once('message', (message) => {
  if (message === 'cancel') {
    controller.abort();
  }
});

try {
  await stageBackup(storage, snapshot, config, controller.signal);
  port.postMessage({ type: 'done' });
} catch (error) {
  port.postMessage({ type: 'failed', message: String(error).slice(0, 1000) });
} finally {
  port.close();
}
