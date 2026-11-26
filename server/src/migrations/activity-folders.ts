import { ActivityStorage, activitiesFolder, activityDirectoryName, activityFolder } from '#src/activity-storage';
import { Schema } from 'effect';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/** Folders of the layout before version 11, relative to a rider folder. */
const Legacy = { Fit: 'fit', Images: 'images', Media: 'medias', Charts: 'activities' } as const;

const columnRow = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  notnull: Schema.Finite,
  dflt_value: Schema.NullOr(Schema.String),
});

const activityRow = Schema.Struct({
  id: Schema.Finite,
  player_id: Schema.NullOr(Schema.Finite),
  start_date: Schema.NullOr(Schema.String),
  date: Schema.NullOr(Schema.String),
  end_date: Schema.NullOr(Schema.String),
  storage_dir: Schema.NullOr(Schema.String),
});

const mediaRow = Schema.Struct({ id: Schema.Finite, player_id: Schema.Finite, activity_id: Schema.Finite });

const cleanupPayload = Schema.Struct({
  activityId: Schema.optional(Schema.Finite),
  playerId: Schema.optional(Schema.Finite),
  images: Schema.optional(Schema.String),
  media: Schema.optional(Schema.String),
});

function syncDirectory(path: string) {
  if (process.platform === 'win32' || !existsSync(path)) {
    return;
  }
  const fd = openSync(path, 'r');

  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function entries(folder: string) {
  return existsSync(folder) && statSync(folder).isDirectory() ? readdirSync(folder, { withFileTypes: true }) : [];
}

function numbers(value = '') {
  return value.split(',').filter((item) => /^\d+$/.test(item));
}

function highest(db: DatabaseSync, sql: string) {
  return Schema.decodeUnknownSync(Schema.Struct({ value: Schema.NullOr(Schema.Finite) }))(db.prepare(sql).get()).value;
}

function riders(storage: string) {
  return entries(storage)
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name));
}

/** Rebuild activity with AUTOINCREMENT, so a deleted activity's id is never handed out again,
and add storage_dir. The sequence starts above every id the database or the legacy export
names still mention.
*/
function rebuildActivityTable(db: DatabaseSync, storage: string) {
  const columns = db
    .prepare('PRAGMA table_info(activity)')
    .all()
    .map((row) => Schema.decodeUnknownSync(columnRow)(row))
    .filter((column) => column.name !== 'id' && column.name !== 'storage_dir');

  const definitions = columns.map((column) =>
    [
      `"${column.name}"`,
      column.type,
      column.notnull ? 'NOT NULL' : '',
      column.dflt_value === null ? '' : `DEFAULT ${column.dflt_value}`,
    ]
      .filter(Boolean)
      .join(' '),
  );

  const indexes = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='activity' AND sql IS NOT NULL")
    .all()
    .map((row) => Schema.decodeUnknownSync(Schema.Struct({ sql: Schema.String }))(row).sql);

  const names = ['id', ...columns.map((column) => column.name)].map((name) => `"${name}"`).join(', ');

  db.exec(
    `CREATE TABLE "activity_v11" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, ${[...definitions, '"storage_dir" TEXT'].join(', ')})`,
  );
  db.exec(`INSERT INTO "activity_v11" (${names}) SELECT ${names} FROM "activity"`);
  db.exec('DROP TABLE "activity"');
  db.exec('ALTER TABLE "activity_v11" RENAME TO "activity"');

  for (const index of indexes) {
    db.exec(index);
  }

  const mentioned = [
    'SELECT max(id) AS value FROM activity',
    'SELECT max(activity_id) AS value FROM activity_completion',
    'SELECT max(activity_id) AS value FROM activity_upload',
    'SELECT max(activity_id) AS value FROM activity_file',
    'SELECT max(activity_id) AS value FROM activity_image',
    'SELECT max(activity_id) AS value FROM activity_media',
    'SELECT max(activity_id) AS value FROM power_curve',
    "SELECT max(CAST(json_extract(payload, '$.activityId') AS INTEGER)) AS value FROM job",
  ].map((sql) => highest(db, sql) ?? 0);

  for (const rider of riders(storage)) {
    const folder = resolve(storage, String(rider));

    for (const directory of [
      resolve(folder, Legacy.Fit),
      resolve(activitiesFolder(folder), ActivityStorage.Orphaned),
    ]) {
      for (const entry of entries(directory)) {
        const id = /^(\d+) - /.exec(entry.name)?.[1];

        if (id !== undefined) {
          mentioned.push(Number(id));
        }
      }
    }
  }

  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('activity', 'activity_v11')");
  db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('activity', ?)").run(Math.max(0, ...mentioned));
}

/** Move a file the migration cannot match into <rider>/activities/orphaned, never over another file. */
function orphan(source: string, target: string, touched: Set<string>) {
  const extension = extname(target);
  const stem = basename(target, extension);
  let path = target;

  for (let copy = 2; existsSync(path); copy++) {
    path = resolve(dirname(target), `${stem} (${copy})${extension}`);
  }

  move(source, path, touched);
}

function move(source: string, target: string, touched: Set<string>) {
  mkdirSync(dirname(target), { recursive: true });
  renameSync(source, target);
  touched.add(dirname(source));
  touched.add(dirname(target));
}

function sameBytes(path: string, bytes: Uint8Array | null) {
  return !!bytes && statSync(path).size === bytes.length && readFileSync(path).equals(bytes);
}

/** Files of activities deleted before the upgrade, whose cleanup jobs have not run yet. */
function removeDeleted(db: DatabaseSync, storage: string) {
  const jobs = db
    .prepare("SELECT payload FROM job WHERE type='artifact_cleanup' AND state IN ('queued', 'running')")
    .all()
    .map((row) => Schema.decodeUnknownSync(Schema.Struct({ payload: Schema.String }))(row).payload);

  for (const text of jobs) {
    const payload = Schema.decodeUnknownOption(cleanupPayload)(JSON.parse(text));

    if (payload._tag === 'None' || payload.value.playerId === undefined) {
      continue;
    }
    const { activityId, playerId, images, media } = payload.value;
    const folder = resolve(storage, String(playerId));

    for (const entry of entries(resolve(folder, Legacy.Fit))) {
      if (activityId !== undefined && entry.name.startsWith(`${activityId} - `)) {
        rmSync(resolve(folder, Legacy.Fit, entry.name), { force: true });
      }
    }

    for (const id of numbers(images)) {
      rmSync(resolve(folder, Legacy.Images, `${id}.jpg`), { force: true });
    }

    for (const id of numbers(media)) {
      for (const extension of ['mp4', 'mov']) {
        rmSync(resolve(folder, Legacy.Media, `${id}.${extension}`), { force: true });
      }
    }
  }
}

/** Version 11: one folder per activity (see activity-storage.ts). Runs inside the schema
migration transaction. File moves are not transactional, so every step is repeatable:
folder names are derived only from the database, and a moved file is not found again at
its old path. A FIT export moves only when it matches the canonical payload; files that
match nothing go to <rider>/activities/orphaned and are never deleted.
*/
export function migrateActivityFolders(db: DatabaseSync, storage: string) {
  rebuildActivityTable(db, storage);

  const assign = db.prepare('UPDATE activity SET storage_dir=? WHERE id=?');

  const activities = new Map(
    db
      .prepare('SELECT id, player_id, start_date, date, end_date, storage_dir FROM activity')
      .all()
      .map((row) => {
        const activity = Schema.decodeUnknownSync(activityRow)(row);
        // No clock fallback: a repeated run must choose the same name.
        const directory =
          activity.storage_dir ??
          activityDirectoryName(activity.id, [activity.start_date, activity.date, activity.end_date], 0);

        if (activity.storage_dir === null) {
          assign.run(directory, activity.id);
        }

        return [activity.id, { player: activity.player_id, directory }];
      }),
  );

  const fit = db.prepare('SELECT fit FROM activity WHERE id=?');

  const canonical = (id: number) =>
    Schema.decodeUnknownSync(Schema.Struct({ fit: Schema.NullOr(Schema.instanceOf(Uint8Array)) }))(fit.get(id)).fit;

  const media = (table: 'activity_image' | 'activity_media') =>
    new Map(
      db
        .prepare(`SELECT id, player_id, activity_id FROM ${table}`)
        .all()
        .map((row) => {
          const parsed = Schema.decodeUnknownSync(mediaRow)(row);

          return [parsed.id, parsed];
        }),
    );

  const images = media('activity_image');
  const videos = media('activity_media');

  removeDeleted(db, storage);

  const touched = new Set<string>();

  for (const rider of riders(storage)) {
    const folder = resolve(storage, String(rider));
    const orphaned = resolve(activitiesFolder(folder), ActivityStorage.Orphaned);

    const owned = (id: number | undefined) => {
      const activity = id === undefined ? undefined : activities.get(id);

      return activity?.player === rider ? activityFolder(folder, activity.directory) : null;
    };

    for (const entry of entries(resolve(folder, Legacy.Fit))) {
      const source = resolve(folder, Legacy.Fit, entry.name);

      if (entry.name.endsWith('.tmp')) {
        rmSync(source, { recursive: true, force: true });
        continue;
      }
      const id = /^(\d+) - /.exec(entry.name)?.[1];
      const target = owned(id === undefined ? undefined : Number(id));
      const bytes = target && entry.isFile() ? canonical(Number(id)) : null;

      if (target && entry.isFile() && sameBytes(source, bytes)) {
        const path = resolve(target, ActivityStorage.Fit);

        if (!existsSync(path)) {
          move(source, path, touched);
          continue;
        }

        if (sameBytes(path, bytes)) {
          rmSync(source);
          continue;
        }
      }
      orphan(source, resolve(orphaned, entry.name), touched);
    }

    for (const [legacy, current, rows, pattern] of [
      [Legacy.Images, ActivityStorage.Images, images, /^(\d+)\.jpg$/],
      [Legacy.Media, ActivityStorage.Videos, videos, /^(\d+)\.(?:mp4|mov)$/],
    ] as const) {
      for (const entry of entries(resolve(folder, legacy))) {
        const source = resolve(folder, legacy, entry.name);

        if (entry.name.endsWith('.tmp')) {
          rmSync(source, { recursive: true, force: true });
          continue;
        }
        const id = pattern.exec(entry.name)?.[1];
        const row = id === undefined ? undefined : rows.get(Number(id));
        const target = row?.player_id === rider ? owned(row.activity_id) : null;

        if (target && entry.isFile() && !existsSync(resolve(target, current, entry.name))) {
          move(source, resolve(target, current, entry.name), touched);
        } else {
          orphan(source, resolve(orphaned, current, entry.name), touched);
        }
      }
    }

    for (const legacy of [Legacy.Fit, Legacy.Images, Legacy.Media]) {
      if (!existsSync(resolve(folder, legacy)) || entries(resolve(folder, legacy)).length > 0) {
        continue;
      }
      rmdirSync(resolve(folder, legacy));
      touched.add(folder);
    }
  }

  // Charts are a cache: they are computed again on demand.
  rmSync(resolve(storage, Legacy.Charts), { recursive: true, force: true });

  for (const directory of touched) {
    syncDirectory(directory);
  }

  // An activity whose export was missing or did not match gets a fresh export.
  const pending = db.prepare(
    "SELECT 1 FROM job WHERE type='fit_export' AND state IN ('queued', 'running') AND json_extract(payload, '$.activityId')=?",
  );
  const enqueue = db.prepare('INSERT INTO job (type, payload, next_run_at, created_at) VALUES (?, ?, ?, ?)');
  const now = Date.now();

  for (const row of db.prepare('SELECT id FROM activity WHERE fit IS NOT NULL AND player_id IS NOT NULL').all()) {
    const id = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(row).id;
    const activity = activities.get(id);

    if (
      !activity ||
      activity.player === null ||
      existsSync(
        resolve(activityFolder(resolve(storage, String(activity.player)), activity.directory), ActivityStorage.Fit),
      ) ||
      pending.get(id)
    ) {
      continue;
    }
    enqueue.run('fit_export', JSON.stringify({ activityId: id }), now, now);
  }
}
