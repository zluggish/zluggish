import { t } from '#src/i18n/index';
import { archiveSuffix, compressBackup, withBackupDirectory } from '#src/migrations/backup-archive';
import {
  backupDirectory,
  backupManifest,
  backupPath,
  excludedStorageEntry,
  legacyDatabases,
  nightlyBackupTimestamp,
} from '#src/migrations/backup-paths';
import { BackupSnapshotWorker } from '#src/migrations/backup-snapshot-worker';
import { ConfigError } from '#src/config/index';
import { configureConnection, SCHEMA_VERSION } from '#src/db/open';
import { StorageFile } from '#src/migrations/storage';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { SystemFlag } from '#src/repositories/system-flag.repository';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { Schema } from 'effect';

const crypto = new CryptoRepository();
const CONFIG = 'config';
const RESTORING = 'zluggish.db.restoring';

const manifestSchema = Schema.Struct({
  version: Schema.Literal(2),
  created: Schema.String,
  schemaVersion: Schema.Finite,
  config: Schema.NullOr(Schema.String),
  checksums: Schema.Record(Schema.String, Schema.String),
});

function sync(path: string, flags = 'r+') {
  if (process.platform === 'win32' && flags === 'r') {
    return;
  }
  const fd = openSync(path, flags);

  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeDurable(path: string, data: string) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, data, { mode: 0o600 });
  sync(temporary);
  renameSync(temporary, path);
  sync(dirname(path), 'r');
}

async function flush(path: string, directory = false) {
  if (process.platform === 'win32' && directory) {
    return;
  }
  const file = await open(path, process.platform === 'win32' ? 'r+' : 'r');

  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function snapshotDatabase(source: string, target: string, signal?: AbortSignal, current = false) {
  const db = new DatabaseSync(source, { readOnly: true, timeout: 5000 });

  try {
    if (current) {
      db.exec('BEGIN');
    }

    const version = current
      ? Schema.decodeUnknownSync(Schema.Finite)(db.prepare('SELECT version FROM version').get()?.version)
      : null;

    if (current && version !== SCHEMA_VERSION) {
      throw new ConfigError(t('backup_storage_upgrade_required'));
    }

    signal?.throwIfAborted();
    await backup(db, target, { progress: () => signal?.throwIfAborted() });
    const destination = new DatabaseSync(target);

    try {
      destination.exec('PRAGMA journal_mode=DELETE');
    } finally {
      destination.close();
    }

    return version;
  } finally {
    db.close();
  }
}

async function copyTree(
  source: string,
  target: string,
  root: string,
  checksums: Record<string, string>,
  durable: boolean,
  signal?: AbortSignal,
) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    signal?.throwIfAborted();
    const top = source === root;

    if (/\.[a-f0-9-]{36}\.tmp$/.test(entry.name)) {
      continue;
    }

    if (top && (excludedStorageEntry(entry.name) || entry.name === StorageFile.Database)) {
      continue;
    }

    const from = resolve(source, entry.name);
    const to = resolve(target, entry.name);

    if (entry.isDirectory()) {
      await mkdir(to);
      await copyTree(from, to, root, checksums, durable, signal);

      if (durable) {
        await flush(to, true);
      }
    } else if (entry.isFile()) {
      if (top && legacyDatabases.includes(entry.name)) {
        await snapshotDatabase(from, to, signal);
      } else {
        await copyFile(from, to);
      }

      if (durable) {
        await flush(to);
      }
      checksums[relative(root, from)] = await crypto.sha256FileAsync(to);
    }
  }
}

function requireSafeBackupOutput(storage: string, output: string) {
  const location = relative(storage, output);

  if (location.startsWith(`backups${sep}`)) {
    return;
  }

  if (!isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`)) {
    throw new ConfigError(t('backup_destination_invalid'));
  }
}

/** Copy a live SQLite database and the storage files into the CLI restore format. */
export function backupStorage(storage: string, output: string, config: string | null) {
  return writeSnapshot(storage, output, config, true);
}

/** A private archive input is disposable. The final archive supplies the durability boundary. */
export function stageBackup(storage: string, output: string, config: string | null, signal?: AbortSignal) {
  return writeSnapshot(storage, output, config, false, signal);
}

async function writeSnapshot(
  storage: string,
  output: string,
  config: string | null,
  durable: boolean,
  signal?: AbortSignal,
) {
  storage = resolve(storage);
  output = resolve(output);
  requireSafeBackupOutput(storage, output);

  await mkdir(output, { recursive: true, mode: 0o700 });

  const entries = await readdir(output);

  if (entries.length > 0) {
    throw new ConfigError(t('backup_destination_not_empty'));
  }

  // A null prototype keeps file names such as __proto__ ordinary keys; Object.create returns any.
  // oxlint-disable-next-line typescript/no-unsafe-assignment
  const checksums: Record<string, string> = Object.create(null);
  const database = resolve(output, StorageFile.Database);
  const schemaVersion = await snapshotDatabase(resolve(storage, StorageFile.Database), database, signal, true);

  if (durable) {
    await flush(database);
  }
  checksums[StorageFile.Database] = await crypto.sha256FileAsync(database);

  await copyTree(storage, output, storage, checksums, durable, signal);

  const configName = config && existsSync(config) ? basename(config) : null;

  if (config && configName) {
    const target = resolve(output, CONFIG, configName);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(config, target);

    if (durable) {
      await flush(target);
      await flush(dirname(target), true);
    }

    checksums[`${CONFIG}/${configName}`] = await crypto.sha256FileAsync(target);
  }

  signal?.throwIfAborted();
  const manifest = resolve(output, backupManifest);
  await writeFile(
    manifest,
    `${JSON.stringify({ version: 2, created: new Date().toISOString(), schemaVersion, config: configName, checksums }, null, 2)}\n`,
    { mode: 0o600 },
  );

  if (durable) {
    await flush(manifest);
    await flush(output, true);
  }

  return Object.keys(checksums).length;
}

/** Build a private snapshot off-thread and publish only while the job can still commit. */
export async function publishBackup(
  storage: string,
  config: string | null,
  name: string,
  signal: AbortSignal,
  assertCurrent: () => void,
) {
  const directory = backupDirectory(storage);
  const target = backupPath(directory, name);
  const archive = target + archiveSuffix;
  await mkdir(directory, { recursive: true, mode: 0o700 });

  // The storage lock and serial backup runner exclude another publisher for this name.
  const stagingPrefix = `.${name}.tmp-`;

  for (const entry of await readdir(directory)) {
    if (entry.startsWith(stagingPrefix) && entry.length === stagingPrefix.length + 6) {
      await rm(resolve(directory, entry), { recursive: true, force: true });
    }
  }

  if (!existsSync(archive) && !existsSync(resolve(target, backupManifest))) {
    const stage = await mkdtemp(resolve(directory, stagingPrefix));

    try {
      const snapshot = resolve(stage, 'snapshot');
      await new BackupSnapshotWorker().run({ storage, config, snapshot }, signal);
      const temporary = await prepareArchive(snapshot, stage, signal);
      signal.throwIfAborted();
      assertCurrent();
      await rename(temporary, archive);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  await flush(directory, true);

  await flush(dirname(directory), true);
}

async function prepareArchive(snapshot: string, stage: string, signal?: AbortSignal) {
  const temporary = resolve(stage, 'backup.tar.gz');
  signal?.throwIfAborted();
  await compressBackup(snapshot, temporary, signal);
  await chmod(temporary, 0o600);
  await flush(temporary);

  return temporary;
}

/** Create an archive for the offline CLI, without overwriting an existing backup. */
export async function backupStorageArchive(storage: string, output: string, config: string | null) {
  requireSafeBackupOutput(storage, output);
  const directory = dirname(output);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  if (existsSync(output)) {
    throw new ConfigError(t('backup_exists'));
  }
  const stage = await mkdtemp(resolve(directory, '.backup-'));

  try {
    const snapshot = resolve(stage, 'snapshot');
    const files = await stageBackup(storage, snapshot, config);
    await rename(await prepareArchive(snapshot, stage), output);
    await flush(directory, true);

    return files;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Retain the 10 newest completed nights. */
export async function pruneNightlyBackups(storage: string) {
  const directory = backupDirectory(storage);
  const entries = await readdir(directory, { withFileTypes: true });

  const nightly: Array<{ name: string; timestamp: string }> = [];

  for (const entry of entries) {
    const archive = entry.isFile() && entry.name.endsWith(archiveSuffix);
    const name = archive ? entry.name.slice(0, -archiveSuffix.length) : entry.name;
    const timestamp = nightlyBackupTimestamp(name);

    if (timestamp && (archive || (entry.isDirectory() && existsSync(resolve(directory, name, backupManifest))))) {
      nightly.push({ name: entry.name, timestamp });
    }
  }

  nightly.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  for (const { name } of nightly.slice(10)) {
    await rm(resolve(directory, name), { recursive: true, force: true });
  }

  await flush(directory, true);
}

function validateBackup(input: string) {
  const path = resolve(input, backupManifest);

  if (!existsSync(path)) {
    throw new ConfigError(t('backup_manifest_missing'));
  }
  const manifest = Schema.decodeUnknownSync(manifestSchema)(JSON.parse(readFileSync(path, 'utf8')));

  if (manifest.config && (basename(manifest.config) !== manifest.config || manifest.config === '..')) {
    throw new ConfigError(t('backup_manifest_config_name_invalid'));
  }

  for (const [name, checksum] of Object.entries(manifest.checksums)) {
    const file = resolve(input, name);
    const location = relative(input, file);

    if (isAbsolute(location) || location === '' || location === '..' || location.startsWith(`..${sep}`)) {
      throw new ConfigError(t('backup_manifest_path_unsafe'));
    }

    if (!existsSync(file) || crypto.sha256File(file) !== checksum) {
      throw new ConfigError(t('backup_file_changed', { value1: name }));
    }
  }

  if (manifest.schemaVersion > SCHEMA_VERSION) {
    throw new ConfigError(t('backup_version_unsupported'));
  }
  const db = new DatabaseSync(resolve(input, StorageFile.Database), { readOnly: true });

  try {
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') {
      throw new ConfigError(t('backup_integrity_check_failed'));
    }

    if (
      db.prepare('SELECT 1 FROM rider_document WHERE encrypted=1 LIMIT 1').get() &&
      !existsSync(resolve(input, StorageFile.CredentialsKey))
    ) {
      throw new ConfigError(t('backup_credentials_key_missing'));
    }
  } finally {
    db.close();
  }

  return manifest;
}

/** Close the current database with its WAL applied, so no sidecar file can be replayed
onto the replacement.
*/
function closeCurrent(storage: string) {
  const path = resolve(storage, StorageFile.Database);

  if (!existsSync(path)) {
    return;
  }
  const db = new DatabaseSync(path);

  try {
    const result = Schema.decodeUnknownSync(Schema.Struct({ busy: Schema.Finite }))(
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(),
    );

    if (result.busy !== 0) {
      throw new ConfigError(t('backup_database_busy'));
    }
    db.exec('PRAGMA journal_mode=DELETE');
  } finally {
    db.close();
  }

  if (existsSync(`${path}-wal`) && statSync(`${path}-wal`).size > 0) {
    throw new ConfigError(t('backup_database_wal_pending'));
  }

  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

/** Offline restore. The caller holds the storage lock. A durable marker blocks startup
until every required file is in place. The restored database carries the upload pause:
a delivery can succeed after its backup was made, so no restored delivery is sent
automatically until an operator clears the pause.
*/
export function restoreStorage(
  storage: string,
  input: string,
  config: string | null,
  reached: (step: 'marked' | 'prepared' | 'published' | 'copied') => void = () => {},
) {
  withBackupDirectory(input, (directory) => restoreDirectory(storage, directory, config, reached, input));
}

function restoreDirectory(
  storage: string,
  directory: string,
  config: string | null,
  reached: (step: 'marked' | 'prepared' | 'published' | 'copied') => void,
  input: string,
) {
  const manifest = validateBackup(directory);
  mkdirSync(storage, { recursive: true });
  writeDurable(
    resolve(storage, StorageFile.RestoreMarker),
    `${JSON.stringify({ input, started: new Date().toISOString() })}\n`,
  );
  reached('marked');

  const restoring = resolve(storage, RESTORING);

  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(`${restoring}${suffix}`, { force: true });
  }
  copyFileSync(resolve(directory, StorageFile.Database), restoring);
  const db = new DatabaseSync(restoring);

  try {
    db.exec('PRAGMA synchronous=FULL');
    db.prepare(
      'INSERT INTO system_flag (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value',
    ).run(SystemFlag.UploadPause, `restore ${manifest.created}`);
    db.exec('PRAGMA journal_mode=DELETE');
  } finally {
    db.close();
  }

  sync(restoring);
  reached('prepared');
  closeCurrent(storage);
  renameSync(restoring, resolve(storage, StorageFile.Database));
  sync(storage, 'r');
  reached('published');

  for (const name of Object.keys(manifest.checksums)) {
    if (name === StorageFile.Database || name.startsWith(`${CONFIG}/`)) {
      continue;
    }
    const target = resolve(storage, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(directory, name), target);
    sync(target);
    reached('copied');
  }

  if (config && manifest.config) {
    copyFileSync(resolve(directory, CONFIG, manifest.config), config);
    sync(config);
  }

  sync(storage, 'r');
  rmSync(resolve(storage, StorageFile.RestoreMarker));
  sync(storage, 'r');
}

/** For a manual directory copy: set the upload pause before the first start. */
export function pauseUploads(storage: string, reason: string) {
  const db = new DatabaseSync(resolve(storage, StorageFile.Database));

  try {
    configureConnection(db);
    db.prepare(
      'INSERT INTO system_flag (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value',
    ).run(SystemFlag.UploadPause, reason);
  } finally {
    db.close();
  }
}
