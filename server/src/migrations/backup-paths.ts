import { t } from '#src/i18n/index';
import { ConfigError } from '#src/config/index';
import { basename, resolve } from 'node:path';

export const backupManifest = 'backup-manifest.json';

export const legacyDatabases: ReadonlyArray<string> = ['zluggish.db', 'zwift-offline.db', 'settings.db'];

export function backupDirectory(storage: string) {
  return resolve(storage, 'backups');
}

export function excludedStorageEntry(name: string) {
  return (
    [
      '.server.lock',
      '.restore-in-progress',
      '.config-migration.json',
      'storage-migration.json',
      backupManifest,
      'backups',
      'companion',
      'zwift-android',
    ].includes(name) ||
    name.startsWith('zluggish.db.migrating') ||
    name.startsWith('zluggish.db.restoring') ||
    legacyDatabases.some((database) => ['-shm', '-wal', '-journal'].some((suffix) => name === database + suffix))
  );
}

export function nightlyBackupName(date: Date) {
  const timestamp = date.toISOString().slice(0, 19).replaceAll(':', '-');

  return `${timestamp}Z-nightly`;
}

export function nightlyBackupTimestamp(name: string) {
  const timestamp = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)-nightly$/.exec(name)?.[1];

  if (timestamp) {
    return timestamp;
  }

  const legacyDate = /^nightly-(\d{4}-\d{2}-\d{2})$/.exec(name)?.[1];

  return legacyDate && `${legacyDate}T02-00-00Z`;
}

/** Backup names are also used as directory names. */
export function backupPath(directory: string, name: string) {
  if (name !== basename(name) || name === '' || name === '.' || name === '..') {
    throw new ConfigError(t('invalid_backup_name'));
  }

  return resolve(directory, name);
}
