import { t } from '#src/i18n/index';
import { archiveSuffix, readArchivedFile } from '#src/migrations/backup-archive';
import { Schema } from 'effect';
import { ConfigError } from '#src/config/index';
import { RiderDocumentName } from '#src/enum';
import { readManifest, StorageFile } from '#src/migrations/storage';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Legacy files that nothing reads after the storage merge. */
const obsolete = new Set(['last_activity.bin']);

export type LegacyFile = { path: string; bytes: number };

export type LegacyPlan = { removable: Array<LegacyFile>; kept: Array<{ path: string; reason: string }> };

const crypto = new CryptoRepository();

/** Legacy stores after a published storage migration. A file is removable only when
the migration backup holds its exact bytes, and the database holds its data (or
nothing reads it). Changed files, unknown files and orphaned riders are kept.
*/
export function legacyPlan(storage: string): LegacyPlan {
  const manifest = readManifest(storage);

  if (manifest?.state !== 'published') {
    throw new ConfigError(t('legacy_migration_missing'));
  }

  const archived = manifest.backup.endsWith(archiveSuffix);
  const backupPath = archived ? manifest.backup : resolve(manifest.backup, 'backup-manifest.json');

  if (!existsSync(backupPath)) {
    throw new ConfigError(t('legacy_backup_missing', { value1: manifest.backup }));
  }

  const backup = Schema.decodeUnknownSync(Schema.Struct({ checksums: Schema.Record(Schema.String, Schema.String) }))(
    JSON.parse(archived ? readArchivedFile(backupPath, 'backup-manifest.json') : readFileSync(backupPath, 'utf8')),
  ).checksums;

  const plan: LegacyPlan = { removable: [], kept: [] };
  const db = new DatabaseSync(resolve(storage, StorageFile.Database), { readOnly: true });

  try {
    const key = existsSync(resolve(storage, StorageFile.CredentialsKey))
      ? readFileSync(resolve(storage, StorageFile.CredentialsKey))
      : null;

    const users = new Set(
      db
        .prepare('SELECT player_id FROM user')
        .all()
        .map((row) => Schema.decodeUnknownSync(Schema.Finite)(row.player_id)),
    );

    const backedUp = (path: string) => backup[relative(storage, path)] === crypto.sha256(readFileSync(path));

    const consider = (path: string, imported: boolean) => {
      if (!backedUp(path)) {
        plan.kept.push({ path, reason: t('legacy_backup_mismatch') });
      } else if (imported) {
        plan.removable.push({ path, bytes: statSync(path).size });
      } else {
        plan.kept.push({ path, reason: t('legacy_database_record_missing') });
      }
    };

    const document = db.prepare('SELECT data, encrypted FROM rider_document WHERE player_id=? AND name=?');
    const bookmark = db.prepare('SELECT 1 FROM bookmark WHERE player_id=? AND course=? AND sport=? AND name=?');

    // The database holds the document; a later change there is newer than the file.
    const stored = (player: number, name: string) => {
      const row = document.get(player, name);

      if (!row) {
        return false;
      }

      if (row.encrypted === 0) {
        return true;
      }

      if (key === null) {
        return false;
      }

      try {
        crypto.decryptSecret(key, Schema.decodeUnknownSync(Schema.instanceOf(Uint8Array))(row.data));

        return true;
      } catch {
        return false;
      }
    };

    for (const folder of readdirSync(storage)) {
      if (!/^\d+$/.test(folder) || !statSync(resolve(storage, folder)).isDirectory()) {
        continue;
      }
      const player = Number(folder);
      const root = resolve(storage, folder);

      if (!users.has(player)) {
        plan.kept.push({ path: root, reason: t('legacy_rider_account_missing') });
        continue;
      }

      for (const name of [...Object.values(RiderDocumentName), ...obsolete]) {
        const path = resolve(root, name);

        if (existsSync(path)) {
          consider(path, obsolete.has(name) || stored(player, name));
        }
      }

      for (const path of files(resolve(root, 'bookmarks'))) {
        const [course = '', sport = '', file = ''] = relative(resolve(root, 'bookmarks'), path).split(sep);

        consider(
          path,
          file.endsWith('.bin') && !!bookmark.get(player, Number(course), Number(sport), basename(file, '.bin')),
        );
      }
    }

    const settings = resolve(storage, StorageFile.Settings);

    if (existsSync(settings)) {
      const legacy = new DatabaseSync(settings, { readOnly: true });

      try {
        const merged =
          [
            'SELECT player_id, value FROM rider_settings ORDER BY 1',
            'SELECT id, value FROM world_settings ORDER BY 1',
            'SELECT id FROM config_migration ORDER BY 1',
          ].every((sql) => JSON.stringify(legacy.prepare(sql).all()) === JSON.stringify(db.prepare(sql).all())) &&
          backup[StorageFile.Settings] !== undefined;

        if (merged) {
          plan.removable.push({ path: settings, bytes: statSync(settings).size });
        } else {
          plan.kept.push({ path: settings, reason: t('legacy_database_rows_mismatch') });
        }
      } finally {
        legacy.close();
      }
    }
  } finally {
    db.close();
  }

  return plan;
}

export function removeLegacy(storage: string, plan: LegacyPlan) {
  for (const file of plan.removable) {
    rmSync(file.path, { force: true });

    if (basename(file.path) === StorageFile.Settings) {
      for (const suffix of ['-wal', '-shm', '-journal']) {
        rmSync(`${file.path}${suffix}`, { force: true });
      }
    }
  }

  for (const folder of readdirSync(storage)) {
    if (!/^\d+$/.test(folder)) {
      continue;
    }

    for (const name of ['bookmarks', 'garth']) {
      removeEmpty(resolve(storage, folder, name));
    }
  }
}

function files(path: string): Array<string> {
  if (!existsSync(path)) {
    return [];
  }

  const found: Array<string> = [];

  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...files(resolve(path, entry.name)));
    } else if (entry.isFile()) {
      found.push(resolve(path, entry.name));
    }
  }

  return found;
}

function removeEmpty(path: string): boolean {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    return false;
  }
  const empty = readdirSync(path).every((name) => removeEmpty(resolve(path, name)));

  if (empty) {
    rmSync(path, { recursive: true });
  }

  return empty;
}
