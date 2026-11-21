import { backupDirectory } from '#src/migrations/backup-paths';
import type { ResolvedConfig } from '#src/config/index';
import { immediate } from '#src/db/transaction';
import { RiderDocumentName } from '#src/enum';
import type { Repositories } from '#src/repositories';
import { JobsService } from '#src/services/jobs.service';
import { RuntimeContext } from '#src/context';
import { Context, Effect, Layer } from 'effect';
import { dirname, resolve, sep } from 'node:path';

const hour = 3_600_000;
const day = 24 * hour;

/** A media reservation older than its upload token is abandoned. */
const reservationMs = hour;

export type RetentionCandidate = {
  path: string;
  bytes: number;
  reason: string;
  identity?: string;
  owner?: { kind: keyof ReturnType<Repositories['activitiesRepository']['owners']>; id: number };
};

export type RetentionPlan = {
  jobs: number;
  deliveries: number;
  media: Array<{ table: 'activity_image' | 'activity_media'; id: number }>;
  files: Array<RetentionCandidate>;
};

export type StorageUsage = Record<
  'database' | 'media' | 'fitExports' | 'charts' | 'ghosts' | 'backups' | 'legacy' | 'other',
  number
>;

export type RetentionScope = {
  repositories: Pick<Repositories, keyof Repositories>;
  retention: ResolvedConfig['retention'];
  storage: string;
};

function cleanup({ repositories, retention, storage }: RetentionScope) {
  const backupsDirectory = backupDirectory(storage);
  const previousDirectory = resolve(dirname(storage), 'backups');

  const legacyBackupsDirectory =
    previousDirectory === storage || previousDirectory === backupsDirectory ? null : previousDirectory;

  async function plan(now = Date.now()): Promise<RetentionPlan> {
    const files: Array<RetentionCandidate> = [];
    const owners = repositories.activitiesRepository.owners();

    const add = async (path: string, reason: string, owner: NonNullable<RetentionCandidate['owner']>) => {
      const info = await repositories.filesRepository.statAsync(path);

      if (info) {
        files.push({ path, bytes: info.bytes, reason, identity: info.identity, owner });
      }
    };

    const media = [
      ...repositories.activitiesRepository
        .abandonedMedia('activity_image', now - reservationMs)
        .map((row) => ({ table: 'activity_image' as const, ...row })),
      ...repositories.activitiesRepository
        .abandonedMedia('activity_media', now - reservationMs)
        .map((row) => ({ table: 'activity_media' as const, ...row })),
    ];

    for (const row of media) {
      const folder = resolve(storage, String(row.player_id));

      if (row.table === 'activity_image') {
        await add(resolve(folder, 'images', `${row.id}.jpg`), 'abandoned upload', { kind: 'images', id: row.id });
      } else {
        for (const extension of ['mp4', 'mov']) {
          await add(resolve(folder, 'medias', `${row.id}.${extension}`), 'abandoned upload', {
            kind: 'media',
            id: row.id,
          });
        }
      }
    }

    const abandoned = new Set(media.map((row) => `${row.table}:${row.id}`));

    for (const entry of await repositories.filesRepository.entriesAsync(resolve(storage, 'activities'))) {
      if (entry.isFile() && /^\d+$/.test(entry.name) && !owners.charts.has(Number(entry.name))) {
        await add(resolve(storage, 'activities', entry.name), 'orphaned chart', {
          kind: 'charts',
          id: Number(entry.name),
        });
      }
    }

    for (const rider of await repositories.filesRepository.entriesAsync(storage)) {
      if (!rider.isDirectory() || !/^\d+$/.test(rider.name)) {
        continue;
      }
      const folder = resolve(storage, rider.name);

      for (const entry of await repositories.filesRepository.entriesAsync(resolve(folder, 'fit'))) {
        const activity = /^(\d+) - /.exec(entry.name)?.[1];

        if (activity !== undefined && !owners.activities.has(Number(activity))) {
          await add(resolve(folder, 'fit', entry.name), 'orphaned FIT export', {
            kind: 'activities',
            id: Number(activity),
          });
        }
      }

      for (const [directory, table, owned] of [
        ['images', 'activity_image', owners.images],
        ['medias', 'activity_media', owners.media],
      ] as const) {
        for (const entry of await repositories.filesRepository.entriesAsync(resolve(folder, directory))) {
          const id = /^(\d+)\.\w+$/.exec(entry.name)?.[1];

          if (id !== undefined && !owned.has(Number(id)) && !abandoned.has(`${table}:${id}`)) {
            await add(resolve(folder, directory, entry.name), 'orphaned media', {
              kind: table === 'activity_image' ? 'images' : 'media',
              id: Number(id),
            });
          }
        }
      }

      await ghosts(resolve(folder, 'ghosts'), files);
    }

    for (const path of await repositories.filesRepository.filesUnder(storage, '.tmp')) {
      if (path.startsWith(backupsDirectory + sep)) {
        continue;
      }

      const info = await repositories.filesRepository.statAsync(path);

      if (info && info.modified < now - retention.temporaryFileHours * hour) {
        files.push({ path, bytes: info.bytes, reason: 'temporary file' });
      }
    }

    for (const directory of [backupsDirectory, legacyBackupsDirectory]) {
      if (directory === null) {
        continue;
      }

      const entries = await repositories.filesRepository.entriesAsync(directory);

      const backups = entries
        .filter(
          (entry) =>
            (entry.isDirectory() || (entry.isFile() && entry.name.endsWith('.tar.gz'))) &&
            entry.name.startsWith('storage-v'),
        )
        .map((entry) => entry.name)
        .toSorted()
        .toReversed();

      for (const name of backups.slice(retention.migrationBackups)) {
        const path = resolve(directory, name);
        files.push({ path, bytes: await size(path), reason: 'old migration backup' });
      }
    }

    return {
      jobs: repositories.jobsRepository.prunable(now - retention.finishedJobsDays * day),
      deliveries: repositories.uploadsRepository.prunable(now - retention.deliveryRecordsDays * day),
      media: media.map((row) => ({ table: row.table, id: row.id })),
      files,
    };
  }

  async function ghosts(directory: string, files: Array<RetentionCandidate>) {
    const entries = await repositories.filesRepository.entriesAsync(directory);
    const recordings = [];

    for (const entry of entries) {
      const path = resolve(directory, entry.name);

      if (entry.isDirectory()) {
        await ghosts(path, files);
      } else if (entry.name.endsWith('.bin')) {
        const info = await repositories.filesRepository.statAsync(path);

        if (info) {
          recordings.push({ path, ...info });
        }
      }
    }

    for (const old of recordings.toSorted((a, b) => b.modified - a.modified).slice(retention.ghostsPerRoute)) {
      files.push({ path: old.path, bytes: old.bytes, reason: 'old ghost recording' });
    }
  }

  async function apply(plan: RetentionPlan, now = Date.now()) {
    let files = 0;
    let bytes = 0;
    immediate(repositories.db, () => {
      repositories.jobsRepository.prune(now - retention.finishedJobsDays * day);
      repositories.uploadsRepository.prune(now - retention.deliveryRecordsDays * day);

      // A preview is only a hint. A reservation may have become ready since then.
      for (const table of ['activity_image', 'activity_media'] as const) {
        const abandoned = new Set(
          repositories.activitiesRepository.abandonedMedia(table, now - reservationMs).map((row) => row.id),
        );
        for (const row of plan.media) {
          if (row.table === table && abandoned.has(row.id)) {
            repositories.activitiesRepository.deleteMedia(table, row.id);
          }
        }
      }
    });

    // Commit the reservation fence before touching files: a filesystem failure must
    // never roll it back and let an in-flight upload mark a removed file ready.
    immediate(repositories.db, () => {
      const owners = repositories.activitiesRepository.owners();
      for (const file of plan.files) {
        const owner = file.owner;
        if (
          !owner ||
          !file.identity ||
          !repositories.filesRepository.removeUnchanged(
            file.path,
            file.identity,
            () => !owners[owner.kind].has(owner.id),
          )
        ) {
          continue;
        }

        files++;
        bytes += file.bytes;
      }
    });

    for (const file of plan.files) {
      if (file.owner) {
        continue;
      }

      await repositories.filesRepository.removeTreeAsync(file.path);
      files++;
      bytes += file.bytes;
    }

    return { files, bytes };
  }

  async function size(path: string): Promise<number> {
    const info = await repositories.filesRepository.statAsync(path);

    if (!info) {
      return 0;
    }

    if (!info.directory) {
      return info.bytes;
    }
    let total = 0;

    for (const entry of await repositories.filesRepository.entriesAsync(path)) {
      total += await size(resolve(path, entry.name));
    }

    return total;
  }

  async function usage(): Promise<StorageUsage> {
    const usage: StorageUsage = {
      database: 0,
      media: 0,
      fitExports: 0,
      charts: 0,
      ghosts: 0,
      backups: legacyBackupsDirectory === null ? 0 : await size(legacyBackupsDirectory),
      legacy: 0,
      other: 0,
    };

    const legacy = new Set<string>([...Object.values(RiderDocumentName), 'bookmarks']);

    const top = new Map<string, keyof StorageUsage>([
      ['backups', 'backups'],
      ['activities', 'charts'],
      ['settings.db', 'legacy'],
    ]);

    const rider = new Map<string, keyof StorageUsage>([
      ['images', 'media'],
      ['medias', 'media'],
      ['fit', 'fitExports'],
      ['ghosts', 'ghosts'],
      ['garth', 'legacy'],
    ]);

    for (const entry of await repositories.filesRepository.entriesAsync(storage)) {
      const path = resolve(storage, entry.name);

      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
        const category = entry.name.startsWith('zluggish.db') ? 'database' : (top.get(entry.name) ?? 'other');
        usage[category] += await size(path);
        continue;
      }

      for (const item of await repositories.filesRepository.entriesAsync(path)) {
        usage[rider.get(item.name) ?? (legacy.has(item.name) ? 'legacy' : 'other')] += await size(
          resolve(path, item.name),
        );
      }
    }

    return usage;
  }

  return {
    plan: Effect.fn('RetentionService.plan')(function* (now: number = Date.now()) {
      return yield* Effect.promise(() => plan(now));
    }),
    apply: Effect.fn('RetentionService.apply')(function* (candidates: RetentionPlan, now: number = Date.now()) {
      return yield* Effect.promise(() => apply(candidates, now));
    }),
    usage: Effect.fn('RetentionService.usage')(function* () {
      return yield* Effect.promise(usage);
    }),
    schedule: Effect.fn('RetentionService.schedule')(function* () {
      repositories.jobsRepository.enqueueOnce('retention', {});
    }),
  };
}

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const jobs = yield* JobsService;
  const repositories = context.accounts.repositories;
  const service = cleanup({ repositories, retention: context.config.retention, storage: context.config.storageDir });

  // A daily job. Each run schedules the next one when it commits.
  yield* jobs.register('retention', {
    concurrency: 1,
    attempts: 3,
    timeoutMs: 600_000,
    run: (job) =>
      Effect.gen(function* () {
        const candidates = yield* service.plan();
        const removed = yield* service.apply(candidates);

        job.commit(() => repositories.jobsRepository.enqueue('retention', {}, day));
        repositories.loggingRepository.info('storage.retention', 'Storage cleanup finished', {
          files: removed.files,
          bytes: removed.bytes,
          jobs: candidates.jobs,
          deliveries: candidates.deliveries,
          media: candidates.media.length,
        });
      }),
  });

  return service;
});

/** Storage growth limits. Never removes unfinished deliveries, retry dependencies or the
canonical FIT payload: those live in the database and only finished rows qualify.
*/
export class RetentionService extends Context.Service<RetentionService, ReturnType<typeof cleanup>>()(
  'zluggish/RetentionService',
) {
  static readonly layer = Layer.effect(RetentionService, make);

  /** A cleanup outside the server, for the command line and tests. It registers no job. */
  static readonly forScope = cleanup;
}
