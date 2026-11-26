import { BackupSnapshotWorker } from '#src/migrations/backup-snapshot-worker';
import { readArchivedFile, withBackupDirectory } from '#src/migrations/backup-archive';
import { JobType } from '#src/enum';
import { backupDirectory } from '#src/migrations/backup-paths';
import { BackupService } from '#src/services/backup.service';
import { ManagementService } from '#src/services/management.service';
import { ActivitiesService } from '#src/services/activities.service';
import { makeAppRuntime } from '#src/layers';
import { DocumentsService } from '#src/services/documents.service';
import { decodeOwned } from '#src/schema';
import { Schema } from 'effect';
import { openDatabase } from '#src/db/open';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { backupStorage, backupStorageArchive, publishBackup, restoreStorage } from '#src/migrations/backup';
import { StorageFile } from '#src/migrations/storage';
import { AccountsService } from '#src/services/auth.service';
import { JobsService } from '#src/services/jobs.service';
import { UploadsService } from '#src/services/uploads.service';
import { binary, mediumFixture, mediumWeb } from '#tests/medium/support';
import { create } from '@bufbuild/protobuf';
import { responseStatus } from '#tests/support/html';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';

const fit = readFileSync(new URL('../fixtures/ride.fit', import.meta.url));

/** A storage directory with one completed activity and one pending delivery, backed up. */
async function backedUp(t: TestContext) {
  const cleanup: Array<() => Promise<void>> = [];
  t.after(async () => {
    for (const close of cleanup) {
      await close();
    }
  });
  const f = await mediumFixture(t);
  f.effects.runSync(DocumentsService.use((service) => service.put(f.rider.player_id, 'runalyze_token.txt', 'token')));

  const data = {
    playerId: BigInt(f.rider.player_id),
    courseId: 6n,
    name: 'Backed up',
    startDate: new Date().toISOString(),
    distanceInMeters: 3000,
    fitFilename: 'ride.fit',
    fit,
  };

  const response = await f.request(`/api/profiles/${f.rider.player_id}/activities`, {
    method: 'POST',
    ...binary(ActivitySchema, data),
  });

  const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(await response.json());
  f.effects.runSync(
    ActivitiesService.use((service) => service.finalize(create(ActivitySchema, { ...data, id: BigInt(id) }))),
  );
  const backup = mkdtempSync(resolve(tmpdir(), 'zluggish-backup-'));
  t.after(() => rmSync(backup, { recursive: true, force: true }));
  await backupStorage(f.config.storageDir, backup, null);

  return { f, backup, cleanup };
}

function reopen(cleanup: Array<() => Promise<void>>, f: Awaited<ReturnType<typeof mediumFixture>>) {
  const accounts = AccountsService.open(f.config.storageDir);
  const context = { ...f, accounts, settings: accounts.repositories.settingsRepository };
  const effects = makeAppRuntime(context);
  Object.assign(context, { effects });
  const uploads = effects.runSync(UploadsService);
  const jobs = effects.runSync(JobsService);
  cleanup.push(async () => {
    await effects.runPromise(jobs.close());
    await effects.dispose();
    accounts.close();
  });

  return { accounts, uploads, jobs, effects };
}

await test('a restored backup sends no delivery that was sent after the backup', async (t) => {
  const { f, backup, cleanup } = await backedUp(t);
  const sends = t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(null, { status: 200 })));
  await f.effects.runPromise(JobsService.use((service) => service.drain()));
  assert.equal(sends.mock.callCount(), 1);
  assert.equal(f.effects.runSync(UploadsService.use((service) => service.status(f.rider.player_id)))[0]?.state, 'sent');
  f.accounts.close();

  restoreStorage(f.config.storageDir, backup, null);
  const restored = reopen(cleanup, f);
  restored.effects.runSync(restored.uploads.start());
  restored.effects.runSync(restored.jobs.start());
  await restored.effects.runPromise(restored.jobs.drain());
  assert.equal(restored.effects.runSync(restored.uploads.status(f.rider.player_id))[0]?.state, 'pending');
  assert.equal(sends.mock.callCount(), 1, 'the upload pause stops the restored delivery');
  assert.equal(restored.accounts.repositories.systemFlagsRepository.get('uploads.paused')?.startsWith('restore'), true);

  assert.equal(restored.accounts.repositories.uploadsRepository.cancel(1, 'runalyze'), true);
  restored.accounts.repositories.systemFlagsRepository.clear('uploads.paused');
  await restored.effects.runPromise(restored.jobs.drain());
  assert.equal(sends.mock.callCount(), 1);
});

await test('a restore without the credentials key stops with a clear error', async (t) => {
  const { f, backup } = await backedUp(t);
  rmSync(resolve(backup, StorageFile.CredentialsKey));
  const manifestPath = resolve(backup, 'backup-manifest.json');

  const manifest = decodeOwned(
    Schema.StructWithRest(Schema.Struct({ checksums: Schema.Record(Schema.String, Schema.String) }), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  )(JSON.parse(readFileSync(manifestPath, 'utf8')));

  delete manifest.checksums[StorageFile.CredentialsKey];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  f.accounts.close();
  assert.throws(() => restoreStorage(f.config.storageDir, backup, null), /no credentials-key\.bin/);
  assert.equal(existsSync(resolve(f.config.storageDir, StorageFile.RestoreMarker)), false);
});

await test('a backup holds the configuration and a restore puts it back', async (t) => {
  const { f } = await backedUp(t);
  const config = resolve(f.config.storageDir, '..', 'zluggish-test.config.ts');
  writeFileSync(config, 'export default { storageDir: "x" };');
  t.after(() => rmSync(config, { force: true }));
  const backup = mkdtempSync(resolve(tmpdir(), 'zluggish-backup-'));
  t.after(() => rmSync(backup, { recursive: true, force: true }));
  await backupStorage(f.config.storageDir, backup, config);
  assert.equal(
    readFileSync(resolve(backup, 'config', 'zluggish-test.config.ts'), 'utf8'),
    'export default { storageDir: "x" };',
  );
  await assert.rejects(() => backupStorage(f.config.storageDir, backup, config), /not empty/);
  writeFileSync(config, 'changed');
  f.accounts.close();
  restoreStorage(f.config.storageDir, backup, config);
  assert.equal(readFileSync(config, 'utf8'), 'export default { storageDir: "x" };');
});

await test('a changed backup file stops the restore before it changes storage', async (t) => {
  const { f, backup } = await backedUp(t);
  writeFileSync(resolve(backup, StorageFile.CredentialsKey), 'changed');
  f.accounts.close();
  assert.throws(() => restoreStorage(f.config.storageDir, backup, null), /missing or changed/);
});

for (const step of ['marked', 'prepared', 'published', 'copied'] as const) {
  await test(`a restore stopped after the ${step} step blocks startup until it runs again`, async (t) => {
    const { f, backup, cleanup } = await backedUp(t);
    const sends = t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(null, { status: 200 })));
    f.accounts.close();

    assert.throws(
      () =>
        restoreStorage(f.config.storageDir, backup, null, (reached) => {
          if (reached === step) {
            throw new Error('stopped');
          }
        }),
      /stopped/,
    );

    assert.throws(() => openDatabase(f.config.storageDir), /restore did not finish/);
    restoreStorage(f.config.storageDir, backup, null);
    const restored = reopen(cleanup, f);
    restored.effects.runSync(restored.jobs.start());
    await restored.effects.runPromise(restored.jobs.drain());
    assert.equal(sends.mock.callCount(), 0);
    assert.equal(restored.effects.runSync(restored.uploads.status(f.rider.player_id))[0]?.state, 'pending');
  });
}

await test('only web administrators can create a restorable manual backup', async (t) => {
  const f = await mediumFixture(t);
  const management = f.effects.runSync(ManagementService);

  const owner = await f.effects.runPromise(
    management.setup({
      mode: 'new',
      key: f.effects.runSync(management.issueSetupKey())!,
      username: 'owner',
      first_name: 'First',
      last_name: 'Rider',
      password: 'test-password',
    }),
  );

  const administrator = mediumWeb(f, owner);
  const rider = mediumWeb(f, f.rider);
  const operation = crypto.randomUUID();
  const url = '/api/manage/server/backups';
  const status = `${url}/${operation}`;
  const name = `manual-${operation}.tar.gz`;
  assert.equal(await responseStatus(rider.request(url, 'POST', { operation })), 403);
  assert.equal(await responseStatus(rider.request(status)), 403);
  assert.equal(await responseStatus(administrator.request(url, 'POST', { operation }, 'invalid')), 403);
  assert.equal(await responseStatus(administrator.request(url, 'POST', { operation: '../storage' })), 400);
  assert.equal(await responseStatus(administrator.request(status)), 404);

  const directory = backupDirectory(f.config.storageDir);
  const queued = await administrator.request(url, 'POST', { operation });
  assert.equal(queued.status, 202);
  assert.deepEqual(await queued.json(), { state: 'queued', name });
  await f.effects.runPromise(JobsService.use((service) => service.drain()));
  const finished = await administrator.request(status);
  assert.deepEqual(await finished.json(), { state: 'done', name });
  const duplicate = await administrator.request(url, 'POST', { operation });
  assert.deepEqual(await duplicate.json(), { state: 'done', name });
  assert.deepEqual(readdirSync(directory), [name]);

  f.accounts.close();
  restoreStorage(f.config.storageDir, resolve(directory, name), null);
  const restored = AccountsService.open(f.config.storageDir);

  try {
    assert.equal(restored.get(owner.player_id)?.role, 'administrator');
  } finally {
    restored.close();
  }
});

await test('the offline archive can write under storage/backups and skips Android app folders', async (t) => {
  const f = await mediumFixture(t);
  const storage = f.config.storageDir;
  const archive = resolve(storage, 'backups', 'offline.tar.gz');
  for (const folder of ['companion', 'zwift-android']) {
    mkdirSync(resolve(storage, folder), { recursive: true });
    writeFileSync(resolve(storage, folder, 'signer.pem'), 'test signer');
  }
  f.accounts.close();

  await backupStorageArchive(storage, archive, null);
  withBackupDirectory(archive, (directory) => {
    assert.ok(!existsSync(resolve(directory, 'companion')));
    assert.ok(!existsSync(resolve(directory, 'zwift-android')));
  });
  restoreStorage(storage, archive, null);

  assert.ok(existsSync(archive));
  await assert.rejects(backupStorageArchive(storage, resolve(storage, 'offline.tar.gz'), null), /backup destination/);
});

await test('nightly jobs run at 02:00 UTC, keep ten complete nights and leave manual and migration backups', async (t) => {
  const f = await mediumFixture(t);
  const storage = f.config.storageDir;
  const directory = backupDirectory(storage);
  const repository = f.accounts.repositories.jobsRepository;
  let now = Date.UTC(2026, 0, 1, 1);
  t.mock.method(repository, 'now', () => now);
  const service = f.effects.runSync(BackupService);
  const schedule = () => f.effects.runSync(service.schedule());

  schedule();
  schedule();
  const first = repository.list(JobType.StorageBackup);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.next_run_at, Date.UTC(2026, 0, 1, 2));

  const manual = crypto.randomUUID();
  f.effects.runSync(service.request(manual));
  const migration = resolve(directory, 'storage-v6-prior');
  mkdirSync(migration, { recursive: true });
  writeFileSync(resolve(directory, 'nightly-2025-12-31.tar.gz'), 'old nightly backup');

  for (let date = 1; date <= 12; date++) {
    now = Date.UTC(2026, 0, date, 2);
    await f.effects.runPromise(JobsService.use((jobs) => jobs.drain()));
  }

  const names = readdirSync(directory).toSorted();

  const nights = Array.from(
    { length: 10 },
    (_, index) => `2026-01-${String(index + 3).padStart(2, '0')}T02-00-00Z-nightly.tar.gz`,
  );

  assert.deepEqual(names, [...nights, `manual-${manual}.tar.gz`, 'storage-v6-prior']);
  assert.ok(nights.every((name) => readArchivedFile(resolve(directory, name), 'backup-manifest.json').length > 0));
  assert.equal(directory, resolve(storage, 'backups'));
  assert.equal(existsSync(resolve(storage, '..', 'backups')), false);
  const manifest = readArchivedFile(resolve(directory, nights.at(-1)!), 'backup-manifest.json');
  assert.doesNotMatch(manifest, /"backups\//);
  assert.equal(repository.pending(JobType.StorageBackup), 1);
  assert.equal(repository.list(JobType.StorageBackup).at(-1)?.next_run_at, Date.UTC(2026, 0, 13, 2));
});

await test('a failed snapshot can retry and an already published archive is reused', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'zluggish-backup-worker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = resolve(root, 'storage');
  const directory = backupDirectory(storage);
  const name = `manual-${crypto.randomUUID()}`;
  const signal = new AbortController().signal;

  await assert.rejects(
    publishBackup(storage, null, name, signal, () => {}),
    /open database/i,
  );
  assert.deepEqual(readdirSync(directory), []);
  openDatabase(storage).close();
  mkdirSync(resolve(directory, `.${name}.tmp-a123bc`));
  const expired = new Error('Claim expired');
  await assert.rejects(
    publishBackup(storage, null, name, signal, () => {
      throw expired;
    }),
    expired,
  );
  assert.deepEqual(readdirSync(directory), []);

  await publishBackup(storage, null, name, signal, () => {});
  const archive = resolve(directory, name + '.tar.gz');
  const original = readFileSync(archive);
  rmSync(resolve(storage, StorageFile.Database));
  await publishBackup(storage, null, name, signal, () => assert.fail('Unexpected publication'));
  assert.deepEqual(readFileSync(archive), original);
});

await test('stopping during a backup joins the worker and leaves the job queued', async (t) => {
  const f = await mediumFixture(t);
  const service = f.effects.runSync(BackupService);
  const jobs = f.effects.runSync(JobsService);
  const operation = crypto.randomUUID();
  const entered = Promise.withResolvers<void>();
  const run = BackupSnapshotWorker.prototype.run;

  t.mock.method(
    BackupSnapshotWorker.prototype,
    'run',
    function (this: BackupSnapshotWorker, ...args: Parameters<typeof run>) {
      const pending = run.apply(this, args);
      entered.resolve();

      return pending;
    },
  );

  f.effects.runSync(service.request(operation));
  await f.effects.runPromise(jobs.start());
  await entered.promise;
  await f.effects.runPromise(jobs.close());

  assert.equal(f.effects.runSync(service.status(operation))?.state, 'queued');
  assert.deepEqual(readdirSync(backupDirectory(f.config.storageDir)), []);
});
