import { t } from '#src/i18n/index';
import { archiveSuffix, compressBackupSync } from '#src/migrations/backup-archive';
import { ConfigError } from '#src/config/index';
import { completionSchemaSQL, storageSchemaSQL } from '#src/db/ddl';
import { RiderDocumentName, SecretDocuments } from '#src/enum';
import { UnreadableCredentialsError } from '#src/errors';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { PlayerProfileSchema, StreaksSchema } from '#src/protocol/generated/profile_pb';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { connectionDocuments } from '#src/repositories/connections.repository';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { ProtobufRows } from '#src/repositories/protobuf.repository';
import { StreakService } from '#src/services/streak.service';
import { clearField, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupDirectory, backupManifest, excludedStorageEntry, legacyDatabases } from '#src/migrations/backup-paths';
import { Schema } from 'effect';
import type { Types } from 'effect';

export const StorageFile = {
  Database: 'zluggish.db',
  Settings: 'settings.db',
  Manifest: 'storage-migration.json',
  Temporary: 'zluggish.db.migrating',
  RestoreMarker: '.restore-in-progress',
  CredentialsKey: 'credentials-key.bin',
} as const;

export const STORAGE_VERSION = 6;

const reportSchema = Schema.Struct({
  riders: Schema.Finite,
  documents: Schema.Finite,
  bookmarks: Schema.Finite,
  settings: Schema.Record(Schema.String, Schema.Finite),
  orphanFolders: Schema.Array(Schema.String),
  invalidOptional: Schema.Array(Schema.String),
  exportMismatches: Schema.Array(Schema.String),
  completionsFinished: Schema.Array(Schema.String),
  ambiguousDeliveries: Schema.Finite,
  importsRolledBack: Schema.Array(Schema.String),
});

type Report = Types.DeepMutable<typeof reportSchema.Type>;

const manifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  state: Schema.Literals(['importing', 'publishing', 'published']),
  started: Schema.String,
  backup: Schema.String,
  sources: Schema.Record(Schema.String, Schema.String),
  destination: Schema.NullOr(Schema.String),
  schemaVersion: Schema.Finite,
  report: Schema.NullOr(reportSchema),
});

type Manifest = (typeof manifestSchema)['Type'];

const crypto = new CryptoRepository();

function syncFile(path: string) {
  const fd = openSync(path, process.platform === 'win32' ? 'r+' : 'r');

  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path: string) {
  if (process.platform === 'win32') {
    return;
  }
  const fd = openSync(path, 'r');

  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeDurable(path: string, data: string | Uint8Array) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, data, { mode: 0o600 });
  syncFile(temporary);
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

function removeDatabase(path: string) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

export function readManifest(storage: string): Manifest | null {
  const path = resolve(storage, StorageFile.Manifest);

  return existsSync(path) ? Schema.decodeUnknownSync(manifestSchema)(JSON.parse(readFileSync(path, 'utf8'))) : null;
}

function writeManifest(storage: string, manifest: Manifest) {
  writeDurable(resolve(storage, StorageFile.Manifest), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Checkpoint a source database completely and confirm that its WAL holds no unapplied
changes. A WAL file is never deleted to pass this check.
*/
function checkpointSource(path: string) {
  if (!existsSync(path)) {
    return;
  }
  const db = new DatabaseSync(path);

  try {
    const result = Schema.decodeUnknownSync(
      Schema.Struct({ busy: Schema.Finite, log: Schema.Finite, checkpointed: Schema.Finite }),
    )(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get());

    if (result.busy !== 0 || result.log !== result.checkpointed) {
      throw new ConfigError(t('storage_checkpoint_failed', { value1: basename(path) }));
    }
  } finally {
    db.close();
  }

  const wal = `${path}-wal`;

  if (existsSync(wal) && statSync(wal).size > 0) {
    throw new ConfigError(t('storage_wal_changes_pending', { value1: basename(path) }));
  }
}

function copyLegacyFile(source: string, target: string) {
  copyFileSync(source, target);
  syncFile(target);
}

function copyLegacyTree(source: string, target: string, checksums: Record<string, string>, root: string) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (source === root && excludedStorageEntry(entry.name)) {
      continue;
    }
    const from = resolve(source, entry.name);
    const to = resolve(target, entry.name);

    if (entry.isDirectory()) {
      mkdirSync(to);
      copyLegacyTree(from, to, checksums, root);
      syncDirectory(to);
    } else if (entry.isFile()) {
      if (source === root && legacyDatabases.includes(entry.name)) {
        const db = new DatabaseSync(from, { readOnly: true, timeout: 5000 });

        try {
          db.prepare('VACUUM INTO ?').run(to);
        } finally {
          db.close();
        }

        syncFile(to);
      } else {
        copyLegacyFile(from, to);
      }

      checksums[relative(root, from)] = crypto.sha256File(to);
    }
  }
}

/** Snapshot the legacy storage while the caller owns the storage lock. */
export function backupLegacyStorage(storage: string, prefix: string) {
  const source = resolve(storage);
  const directory = backupDirectory(source);
  const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
  const started = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const name = `${prefix}-${started}-${crypto.randomUUID()}`;
  const target = resolve(directory, name + archiveSuffix);
  const stage = mkdtempSync(resolve(directory, '.migration-'));
  const snapshot = resolve(stage, 'snapshot');
  const archive = resolve(stage, 'backup.tar.gz');

  try {
    mkdirSync(snapshot);
    // A null prototype keeps file names such as __proto__ ordinary keys; Object.create returns any.
    // oxlint-disable-next-line typescript/no-unsafe-assignment
    const checksums: Record<string, string> = Object.create(null);
    copyLegacyTree(source, snapshot, checksums, source);
    writeDurable(resolve(snapshot, backupManifest), `${JSON.stringify({ version: 1, checksums }, null, 2)}\n`);
    compressBackupSync(snapshot, archive);
    chmodSync(archive, 0o600);
    syncFile(archive);
    renameSync(archive, target);
    syncDirectory(directory);

    if (created) {
      syncDirectory(dirname(directory));
    }

    return target;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function credentialsKey(storage: string) {
  const file = resolve(storage, StorageFile.CredentialsKey);

  if (!existsSync(file)) {
    writeDurable(file, crypto.randomBytes(32));
  }
  const key = readFileSync(file);

  if (key.length !== 32) {
    throw new ConfigError(t('storage_credentials_key_invalid'));
  }

  return key;
}

const importManifest = Schema.Struct({
  playerId: Schema.Finite,
  files: Schema.Array(Schema.String),
  before: Schema.Struct({
    firstName: Schema.String,
    lastName: Schema.String,
    officialPlayerId: Schema.NullOr(Schema.String),
  }),
  state: Schema.Literals(['staged', 'publishing', 'committed']),
});

/** Legacy profile imports that stopped while publishing are rolled back, exactly as the
previous release did at startup, before their files are imported.
*/
function rollbackLegacyImports(storage: string, db: DatabaseSync, report: Report) {
  for (const rider of readdirSync(storage)) {
    if (!/^\d+$/.test(rider)) {
      continue;
    }
    const folder = resolve(storage, rider);

    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\.ts-import-[a-f0-9]{32}$/.test(entry.name)) {
        continue;
      }
      const stage = resolve(folder, entry.name);
      const path = resolve(stage, 'manifest.json');

      if (!existsSync(path)) {
        continue;
      }
      const manifest = Schema.decodeUnknownSync(importManifest)(JSON.parse(readFileSync(path, 'utf8')));

      if (manifest.state !== 'publishing') {
        continue;
      }

      for (const name of manifest.files) {
        const old = resolve(stage, `old-${name}`);
        const current = resolve(folder, name);

        if (existsSync(old)) {
          copyFileSync(old, current);
        } else {
          rmSync(current, { force: true });
        }
      }

      db.prepare('UPDATE user SET first_name=?, last_name=?, official_player_id=? WHERE player_id=?').run(
        manifest.before.firstName,
        manifest.before.lastName,
        manifest.before.officialPlayerId,
        manifest.playerId,
      );
      rmSync(stage, { recursive: true });
      report.importsRolledBack.push(`${rider}/${entry.name}`);
    }
  }
}

function importSettings(storage: string, db: DatabaseSync) {
  const path = resolve(storage, StorageFile.Settings);
  const counts = { rider_settings: 0, config_migration: 0, world_settings: 0 };

  if (!existsSync(path)) {
    return counts;
  }
  const source = new DatabaseSync(path, { readOnly: true });

  try {
    const version = Schema.decodeUnknownSync(Schema.Struct({ user_version: Schema.Finite }))(
      source.prepare('PRAGMA user_version').get(),
    );

    if (version.user_version > 1) {
      throw new ConfigError(t('unsupported_settings_database_version'));
    }

    const tables = new Set(
      source
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => Schema.decodeUnknownSync(Schema.String)(row.name)),
    );

    const statements = [
      ['rider_settings', 'SELECT player_id, value FROM rider_settings', 'INSERT INTO rider_settings VALUES (?, ?)'],
      ['config_migration', 'SELECT id FROM config_migration', 'INSERT INTO config_migration VALUES (?)'],
      ['world_settings', 'SELECT id, value FROM world_settings', 'INSERT INTO world_settings VALUES (?, ?)'],
    ] as const;

    for (const [table, select, insert] of statements) {
      if (!tables.has(table)) {
        continue;
      }
      const statement = db.prepare(insert);

      for (const row of source.prepare(select).all()) {
        statement.run(
          ...Object.values(row).map((value) =>
            Schema.decodeUnknownSync(Schema.Union([Schema.Finite, Schema.String]))(value),
          ),
        );
        counts[table]++;
      }
    }
  } finally {
    source.close();
  }

  return counts;
}

const documentNames = Object.values(RiderDocumentName);
const credentialDocuments = new Set<string>(Object.values(connectionDocuments));

function importRiderFiles(storage: string, db: DatabaseSync, key: Uint8Array, report: Report) {
  const users = new Set(
    db
      .prepare('SELECT player_id FROM user')
      .all()
      .map((row) => Schema.decodeUnknownSync(Schema.Finite)(row.player_id)),
  );

  const insertDocument = db.prepare(
    'INSERT INTO rider_document (player_id, name, data, encrypted) VALUES (?, ?, ?, ?)',
  );

  const insertBookmark = db.prepare(
    'INSERT OR REPLACE INTO bookmark (player_id, course, sport, name, state) VALUES (?, ?, ?, ?, ?)',
  );

  for (const name of readdirSync(storage)) {
    if (!/^\d+$/.test(name) || !statSync(resolve(storage, name)).isDirectory()) {
      continue;
    }
    const player = Number(name);

    if (!users.has(player)) {
      report.orphanFolders.push(name);
      continue;
    }

    report.riders++;
    const folder = resolve(storage, name);

    for (const document of documentNames) {
      const path = resolve(folder, document);

      if (!existsSync(path)) {
        continue;
      }
      const data = readFileSync(path);

      // Required progression documents must decode; invalid files stop the migration.
      if (document === 'profile.bin') {
        fromBinary(PlayerProfileSchema, data);
      } else if (document === 'streaks.bin') {
        fromBinary(StreaksSchema, data);
      } else if (credentialDocuments.has(document)) {
        try {
          crypto.decryptCredentials(key, data);
        } catch (error) {
          if (!(error instanceof UnreadableCredentialsError)) {
            throw error;
          }

          // Another credentials key wrote them. The legacy file stays; the rider enters them again.
          report.invalidOptional.push(`${name}/${document}`);
          continue;
        }
      }

      const secret = SecretDocuments.includes(document);
      insertDocument.run(player, document, secret ? crypto.encryptSecret(key, data) : data, secret ? 1 : 0);
      report.documents++;
    }

    const bookmarks = resolve(folder, 'bookmarks');

    if (!existsSync(bookmarks)) {
      continue;
    }

    for (const course of readdirSync(bookmarks)) {
      if (!/^\d+$/.test(course) || !statSync(resolve(bookmarks, course)).isDirectory()) {
        continue;
      }

      for (const sport of readdirSync(resolve(bookmarks, course))) {
        const directory = resolve(bookmarks, course, sport);

        if (!/^\d+$/.test(sport) || !statSync(directory).isDirectory()) {
          continue;
        }

        for (const file of readdirSync(directory)) {
          if (!file.endsWith('.bin')) {
            continue;
          }
          const data = readFileSync(resolve(directory, file));

          try {
            fromBinary(PlayerStateSchema, data);
          } catch {
            report.invalidOptional.push(`${name}/bookmarks/${course}/${sport}/${file}`);
            continue;
          }

          insertBookmark.run(player, Number(course), Number(sport), basename(file, '.bin'), data);
          report.bookmarks++;
        }
      }
    }
  }
}

const completionRow = Schema.Struct({
  activity_id: Schema.Finite,
  player_id: Schema.Finite,
  payload: Schema.instanceOf(Uint8Array),
  streak: Schema.NullOr(Schema.instanceOf(Uint8Array)),
  done: Schema.Finite,
});

function exportFile(storage: string, player: number, activity: number) {
  const folder = resolve(storage, String(player), 'fit');

  if (!existsSync(folder)) {
    return null;
  }
  const name = readdirSync(folder).find((file) => file.startsWith(`${activity} - `));

  return name ? resolve(folder, name) : null;
}

function enqueue(db: DatabaseSync, type: string, payload: Record<string, number | string>) {
  const now = Date.now();
  db.prepare('INSERT INTO job (type, payload, next_run_at, created_at) VALUES (?, ?, ?, ?)').run(
    type,
    JSON.stringify(payload),
    now,
    now,
  );
}

/** One canonical FIT payload in activity.fit. Required copies (column and journal) must
agree byte for byte; export files are replaceable copies and are created again.
*/
function canonicalizeFit(storage: string, db: DatabaseSync, report: Report, checksums: Map<number, string>) {
  const completions = new Map(
    db
      .prepare('SELECT * FROM activity_completion')
      .all()
      .map((row) => {
        const parsed = Schema.decodeUnknownSync(completionRow)(row);

        return [parsed.activity_id, parsed];
      }),
  );

  const activities = db.prepare('SELECT id, player_id, fit FROM activity').all();
  const setFit = db.prepare('UPDATE activity SET fit=? WHERE id=?');
  const setPayload = db.prepare('UPDATE activity_completion SET payload=? WHERE activity_id=?');

  for (const row of activities) {
    const activity = Schema.decodeUnknownSync(
      Schema.Struct({
        id: Schema.Finite,
        player_id: Schema.NullOr(Schema.Finite),
        fit: Schema.NullOr(Schema.instanceOf(Uint8Array)),
      }),
    )(row);

    const completion = completions.get(activity.id);
    const journal = completion ? fromBinary(ActivitySchema, completion.payload) : null;
    const column = activity.fit && activity.fit.length > 0 ? activity.fit : null;
    const journalFit = journal && journal.fit.length > 0 ? journal.fit : null;

    if (column && journalFit && !Buffer.from(column).equals(Buffer.from(journalFit))) {
      throw new ConfigError(t('storage_fit_payload_conflict', { value1: activity.id }));
    }
    const file = activity.player_id === null ? null : exportFile(storage, activity.player_id, activity.id);
    const exported = file ? readFileSync(file) : null;
    const canonical = column ?? journalFit ?? exported;

    if (exported && canonical && !exported.equals(Buffer.from(canonical))) {
      report.exportMismatches.push(String(activity.id));
    }

    if (canonical && !column) {
      setFit.run(canonical, activity.id);
    }

    if (canonical) {
      checksums.set(activity.id, crypto.sha256(canonical));
    }

    if (canonical && activity.player_id !== null && (!file || report.exportMismatches.includes(String(activity.id)))) {
      enqueue(db, 'fit_export', { activityId: activity.id });
    }

    if (!journal || !journalFit) {
      continue;
    }
    clearField(journal, ActivitySchema.field.fit);
    setPayload.run(toBinary(ActivitySchema, journal), activity.id);
  }
}

/** A completion with done = 0 stopped between its journal and its commit. Its streak
snapshot replaces the rider's streaks once, only if the rider files hold the state
it was derived from or already hold the snapshot.
*/
function finishCompletions(db: DatabaseSync, report: Report) {
  // Runs after the rider files are imported: report.documents counts the new rows.
  const rows = db.prepare('SELECT * FROM activity_completion WHERE done=0 ORDER BY activity_id').all();

  for (const row of rows) {
    const completion = Schema.decodeUnknownSync(completionRow)(row);
    const activity = fromBinary(ActivitySchema, completion.payload);

    if (completion.streak) {
      const current = db
        .prepare("SELECT data FROM rider_document WHERE player_id=? AND name='streaks.bin'")
        .get(completion.player_id);

      const profile = db
        .prepare("SELECT data FROM rider_document WHERE player_id=? AND name='profile.bin'")
        .get(completion.player_id);

      const stored = current
        ? fromBinary(StreaksSchema, Schema.decodeUnknownSync(Schema.instanceOf(Uint8Array))(current.data))
        : null;

      const previous =
        stored ??
        StreakService.fromProfile(
          profile
            ? fromBinary(PlayerProfileSchema, Schema.decodeUnknownSync(Schema.instanceOf(Uint8Array))(profile.data))
            : null,
        );

      const snapshot = Buffer.from(completion.streak);

      const applied = stored && Buffer.from(toBinary(StreaksSchema, stored)).equals(snapshot);

      const derived = Buffer.from(toBinary(StreaksSchema, StreakService.advancedStreak(previous, activity))).equals(
        snapshot,
      );

      if (!applied && !derived) {
        throw new ConfigError(
          t('storage_streak_journal_mismatch', {
            value1: completion.activity_id,
            value2: completion.player_id,
          }),
        );
      }

      if (!applied) {
        db.prepare(
          "INSERT INTO rider_document (player_id, name, data) VALUES (?, 'streaks.bin', ?) ON CONFLICT DO UPDATE SET data=excluded.data",
        ).run(completion.player_id, snapshot);
      }

      if (!current) {
        report.documents++;
      }
    }

    new ProtobufRows(db).update('activity', BigInt(completion.activity_id), ActivitySchema, activity, ['fit']);
    db.prepare('UPDATE activity_completion SET done=1 WHERE activity_id=?').run(completion.activity_id);
    enqueue(db, 'power_curve', { activityId: completion.activity_id });
    enqueue(db, 'completion_deliveries', { activityId: completion.activity_id });
    report.completionsFinished.push(String(completion.activity_id));
  }
}

function mapDeliveries(db: DatabaseSync, report: Report) {
  report.ambiguousDeliveries = Number(
    db.prepare("UPDATE activity_upload SET state='ambiguous', updated_at=? WHERE state='sending'").run(Date.now())
      .changes,
  );

  for (const row of db.prepare("SELECT activity_id, provider FROM activity_upload WHERE state='pending'").all()) {
    enqueue(db, 'delivery', {
      activityId: Schema.decodeUnknownSync(Schema.Finite)(row.activity_id),
      provider: Schema.decodeUnknownSync(Schema.String)(row.provider),
    });
  }
}

function count(db: DatabaseSync, sql: string) {
  return Schema.decodeUnknownSync(Schema.Finite)(db.prepare(sql).get()?.n);
}

function validate(source: string, destination: DatabaseSync, report: Report, checksums: Map<number, string>) {
  const integrity = destination.prepare('PRAGMA integrity_check').get();

  if (integrity?.integrity_check !== 'ok') {
    throw new ConfigError(t('storage_integrity_check_failed'));
  }

  if (destination.prepare('PRAGMA foreign_key_check').all().length > 0) {
    throw new ConfigError(t('storage_foreign_key_check_failed'));
  }
  const original = new DatabaseSync(source, { readOnly: true });

  try {
    for (const table of [
      'user',
      'activity',
      'activity_completion',
      'activity_upload',
      'segment_result',
      'route_result',
    ]) {
      const optional = table === 'activity_completion' || table === 'activity_upload';
      const exists = original.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
      const sql = `SELECT count(*) AS n FROM ${table}`;
      const originalCount = optional && !exists ? 0 : count(original, sql);

      if (originalCount !== count(destination, sql)) {
        throw new ConfigError(t('storage_source_rows_mismatch', { value1: table }));
      }
    }

    const ids = (db: DatabaseSync) =>
      db
        .prepare('SELECT player_id, username, pass_hash, auth_version FROM user ORDER BY player_id')
        .all()
        .map((row) => JSON.stringify(row));

    if (JSON.stringify(ids(original)) !== JSON.stringify(ids(destination))) {
      throw new ConfigError(t('storage_identity_mismatch'));
    }
  } finally {
    original.close();
  }

  if (count(destination, 'SELECT count(*) AS n FROM rider_document') !== report.documents) {
    throw new ConfigError(t('storage_rider_documents_incomplete'));
  }

  for (const [table, rows] of Object.entries(report.settings)) {
    if (count(destination, `SELECT count(*) AS n FROM ${table}`) !== rows) {
      throw new ConfigError(t('storage_settings_rows_mismatch', { value1: table }));
    }
  }

  for (const row of destination.prepare('SELECT id, fit FROM activity WHERE fit IS NOT NULL').all()) {
    const id = Schema.decodeUnknownSync(Schema.Finite)(row.id);

    if (checksums.get(id) !== crypto.sha256(Schema.decodeUnknownSync(Schema.instanceOf(Uint8Array))(row.fit))) {
      throw new ConfigError(t('storage_fit_payload_mismatch', { value1: id }));
    }
    checksums.delete(id);
  }

  if (checksums.size > 0) {
    throw new ConfigError(t('storage_fit_payload_missing'));
  }

  for (const row of destination.prepare('SELECT payload FROM activity_completion').all()) {
    if (
      fromBinary(ActivitySchema, Schema.decodeUnknownSync(Schema.instanceOf(Uint8Array))(row.payload)).fit.length > 0
    ) {
      throw new ConfigError(t('storage_completion_payload_retained'));
    }
  }
}

/** Resolve an interrupted migration from its manifest before the database opens. */
export function resolvePendingMigration(storage: string) {
  const manifest = readManifest(storage);

  if (!manifest || manifest.state === 'published') {
    return;
  }
  const database = resolve(storage, StorageFile.Database);
  const temporary = resolve(storage, StorageFile.Temporary);

  if (manifest.state === 'importing') {
    removeDatabase(temporary);
    rmSync(resolve(storage, StorageFile.Manifest));
    syncDirectory(storage);

    return;
  }

  const current = existsSync(database) ? crypto.sha256File(database) : null;

  if (current !== null && current === manifest.destination) {
    removeDatabase(temporary);
    writeManifest(storage, { ...manifest, state: 'published' });

    return;
  }

  if (current !== null && current === manifest.sources[StorageFile.Database]) {
    removeDatabase(temporary);
    rmSync(resolve(storage, StorageFile.Manifest));
    syncDirectory(storage);

    return;
  }

  throw new ConfigError(
    t('storage_migration_recovery_conflict', { value1: StorageFile.Database }) +
      t('storage_restore_hint', { value1: StorageFile.Database, value2: manifest.backup }),
  );
}

export const MigrationStep = {
  Checkpointed: 'checkpointed',
  Importing: 'importing',
  BackedUp: 'backed-up',
  Imported: 'imported',
  Flushed: 'flushed',
  Publishing: 'publishing',
  Renamed: 'renamed',
  DirectoryFlushed: 'directory-flushed',
  Published: 'published',
} as const;

export type MigrationStep = (typeof MigrationStep)[keyof typeof MigrationStep];

/** Version 5 -> 6. The caller holds the storage lock; nothing else uses storage.
backup -> import into a temporary database -> validate -> close -> manifest ->
atomic rename -> durable manifest. Legacy stores are kept. Tests stop the process
after a step with `reached`.
*/
export function migrateStorage(storage: string, reached: (step: MigrationStep) => void = () => {}) {
  const database = resolve(storage, StorageFile.Database);
  const temporary = resolve(storage, StorageFile.Temporary);
  const started = new Date().toISOString();

  const backup = backupLegacyStorage(storage, `storage-v${STORAGE_VERSION}`);

  for (const source of [database, resolve(storage, StorageFile.Settings)]) {
    checkpointSource(source);
  }
  reached('checkpointed');

  const sources = Object.fromEntries(
    [StorageFile.Database, StorageFile.Settings].flatMap((name) =>
      existsSync(resolve(storage, name)) ? [[name, crypto.sha256File(resolve(storage, name))]] : [],
    ),
  );

  const manifest: Manifest = {
    version: 1,
    state: 'importing',
    started,
    backup,
    sources,
    destination: null,
    schemaVersion: STORAGE_VERSION,
    report: null,
  };

  writeManifest(storage, manifest);
  reached('importing');
  reached('backed-up');
  removeDatabase(temporary);

  const source = new DatabaseSync(database, { readOnly: true });

  try {
    source.prepare('VACUUM INTO ?').run(temporary);
  } finally {
    source.close();
  }

  const report: Report = {
    riders: 0,
    documents: 0,
    bookmarks: 0,
    settings: {},
    orphanFolders: [],
    invalidOptional: [],
    exportMismatches: [],
    completionsFinished: [],
    ambiguousDeliveries: 0,
    importsRolledBack: [],
  };

  const checksums = new Map<number, string>();
  const db = new DatabaseSync(temporary);
  let imported = false;

  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    db.exec(completionSchemaSQL);
    db.exec(storageSchemaSQL);
    report.settings = importSettings(storage, db);
    rollbackLegacyImports(storage, db, report);
    importRiderFiles(storage, db, credentialsKey(storage), report);
    canonicalizeFit(storage, db, report, checksums);
    finishCompletions(db, report);
    mapDeliveries(db, report);
    db.exec('DELETE FROM version');
    db.prepare('INSERT INTO version VALUES (?)').run(STORAGE_VERSION);
    db.exec('COMMIT');
    validate(database, db, report, checksums);
    db.exec('PRAGMA journal_mode=DELETE');
    imported = true;
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK');
    }
    throw error;
  } finally {
    db.close();

    // A failed import leaves the source as it was: no temporary copy, no manifest.
    if (!imported) {
      removeDatabase(temporary);
      rmSync(resolve(storage, StorageFile.Manifest), { force: true });
      syncDirectory(storage);
    }
  }

  reached('imported');

  if (existsSync(`${temporary}-wal`) || existsSync(`${temporary}-journal`)) {
    throw new ConfigError(t('storage_journal_retained'));
  }
  syncFile(temporary);
  reached('flushed');
  writeManifest(storage, { ...manifest, state: 'publishing', destination: crypto.sha256File(temporary), report });
  reached('publishing');
  renameSync(temporary, database);
  reached('renamed');
  syncDirectory(storage);
  reached('directory-flushed');
  writeManifest(storage, { ...manifest, state: 'published', destination: crypto.sha256File(database), report });
  reached('published');

  return report;
}
