import { openSync, closeSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { flockSync, lockFileExSync, unlockFileExSync, constants } from 'fs-ext-extra-prebuilt';
import { ConfigError } from '#src/config/index';

/** Same OS lock as Python FileLock; the descriptor stays open for the owner's lifetime. */
export function acquireStorageLock(storage: string): Promise<() => Promise<void>> {
  return Promise.try(() => {
    mkdirSync(storage, { recursive: true });
    const descriptor = openSync(resolve(storage, '.server.lock'), 'a+', 0o600);

    try {
      if (process.platform === 'win32')
        lockFileExSync(descriptor, constants.LOCKFILE_EXCLUSIVE_LOCK | constants.LOCKFILE_FAIL_IMMEDIATELY, 0, 0, 1, 0);
      else flockSync(descriptor, 'exnb');
    } catch {
      closeSync(descriptor);
      throw new ConfigError('Storage is busy or cannot be locked; stop the server before changing it');
    }

    let closed = false;

    return () =>
      Promise.try(() => {
        if (closed) return;
        closed = true;

        try {
          if (process.platform === 'win32') unlockFileExSync(descriptor, 0, 0, 1, 0);
          else flockSync(descriptor, 'un');
        } finally {
          closeSync(descriptor);
        }
      });
  });
}
