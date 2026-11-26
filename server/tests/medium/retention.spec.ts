import { ActivitiesService } from '#src/services/activities.service';
import { JobsService } from '#src/services/jobs.service';
import { DocumentsService } from '#src/services/documents.service';
import { validateConfig } from '#src/config/index';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { AssetFiles } from '#src/repositories/files.repository';
import { RetentionService } from '#src/services/retention.service';
import { activityFolderOf, binary, mediumFixture } from '#tests/medium/support';
import { create } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { Effect, Schema } from 'effect';

const fit = readFileSync(new URL('../fixtures/ride.fit', import.meta.url));
const day = 86_400_000;

function write(path: string, data = 'data', ageMs = 0) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, data);
  const time = (Date.now() - ageMs) / 1000;
  utimesSync(path, time, time);
}

/** A rider with one completed activity and every kind of retention candidate. */
async function storage(t: TestContext) {
  const f = await mediumFixture(t);
  f.effects.runSync(DocumentsService.use((service) => service.put(f.rider.player_id, 'runalyze_token.txt', 'token')));
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(null, { status: 200 })));

  const data = {
    playerId: BigInt(f.rider.player_id),
    courseId: 6n,
    name: 'Kept',
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
  await f.effects.runPromise(JobsService.use((service) => service.drain()));

  const root = f.config.storageDir;
  const folder = f.profiles.folder(f.rider.player_id);
  const activity = activityFolderOf(f, id);
  const db = f.accounts.db;
  const old = Date.now() - 400 * day;

  write(resolve(folder, 'activities', '2026-01-01T000000Z_999', 'activity.fit'));
  write(resolve(activity, 'images', '999.jpg'));
  // Files the folder migration could not match are kept for the operator.
  write(resolve(folder, 'activities', 'orphaned', '3 - 2026-08-15-09-10-45.fit'), 'data', 400 * day);

  const reserved = Number(
    db
      .prepare(
        "INSERT INTO activity_media (player_id, activity_id, content_type, state, created_at) VALUES (?, ?, 'video/mp4', 'reserved', ?)",
      )
      .run(f.rider.player_id, id, Date.now() - 2 * 3_600_000).lastInsertRowid,
  );

  write(resolve(activity, 'videos', `${reserved}.mp4`));

  const fresh = Number(
    db
      .prepare(
        "INSERT INTO activity_media (player_id, activity_id, content_type, state, created_at) VALUES (?, ?, 'video/mp4', 'reserved', ?)",
      )
      .run(f.rider.player_id, id, Date.now()).lastInsertRowid,
  );

  write(resolve(activity, 'videos', `${fresh}.mp4`));
  write(resolve(folder, 'profile.bin.abc.tmp'), 'data', 2 * day);
  write(resolve(folder, 'recent.tmp'));
  // Unfinished ride recovery data is never a cleanup candidate, however old.
  write(resolve(folder, 'ride-recovery.bin'), 'samples', 400 * day);

  for (const [name, age] of [
    ['a.bin', 3],
    ['b.bin', 2],
    ['c.bin', 1],
  ] as const) {
    write(resolve(folder, 'ghosts', '6', '1', name), 'ghost', age * day);
  }

  for (const name of ['storage-v6-2026-01-01', 'storage-v6-2026-02-01', 'storage-v6-2026-03-01']) {
    write(resolve(root, 'backups', name, 'zluggish.db'));
  }

  db.prepare("UPDATE job SET finished_at=? WHERE state='done'").run(old);
  db.prepare(
    "INSERT INTO job (type, payload, state, next_run_at, created_at) VALUES ('power_curve', '{}', 'queued', ?, ?)",
  ).run(old, old);
  db.prepare('UPDATE activity_upload SET updated_at=?').run(old);
  db.prepare(
    "INSERT INTO activity_upload (activity_id, provider, state, updated_at) VALUES (?, 'garmin', 'ambiguous', ?)",
  ).run(id, old);

  const retention = validateConfig({
    storageDir: root,
    retention: { ghostsPerRoute: 2, migrationBackups: 2, finishedJobsDays: 14, deliveryRecordsDays: 365 },
  }).retention;

  return {
    f,
    id,
    folder,
    activity,
    root,
    reserved,
    fresh,
    service: RetentionService.forScope({ repositories: f.accounts.repositories, retention, storage: root }),
  };
}

await test('a cleanup preview lists the candidates and removes nothing', async (t) => {
  const { f, folder, activity, root, reserved, service } = await storage(t);
  const plan = await Effect.runPromise(service.plan());
  const reasons = new Map(plan.files.map((file) => [file.path, file.reason]));

  assert.equal(reasons.get(resolve(folder, 'activities', '2026-01-01T000000Z_999')), 'orphaned activity folder');
  assert.equal(reasons.get(resolve(activity, 'images', '999.jpg')), 'orphaned media');
  assert.equal(reasons.get(resolve(activity, 'videos', `${reserved}.mp4`)), 'abandoned upload');
  assert.equal(reasons.get(resolve(folder, 'profile.bin.abc.tmp')), 'temporary file');
  assert.equal(reasons.get(resolve(folder, 'ghosts', '6', '1', 'a.bin')), 'old ghost recording');
  assert.equal(reasons.get(resolve(root, 'backups', 'storage-v6-2026-01-01')), 'old migration backup');
  assert.equal(plan.files.length, 6);
  assert.ok(plan.jobs >= 4);
  assert.equal(plan.deliveries, 1);
  assert.deepEqual(plan.media, [{ table: 'activity_media', id: reserved }]);

  for (const path of reasons.keys()) {
    assert.ok(existsSync(path), `the preview keeps ${path}`);
  }
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM activity_upload').get()?.n, 2);
});

await test('a cleanup keeps unfinished work, owned artifacts and the canonical FIT payload', async (t) => {
  const { f, id, folder, activity, fresh, service } = await storage(t);
  const removed = await Effect.runPromise(service.apply(await Effect.runPromise(service.plan())));
  assert.equal(removed.files, 6);
  const db = f.accounts.db;

  assert.deepEqual(
    db
      .prepare('SELECT provider, state FROM activity_upload ORDER BY provider')
      .all()
      .map((row) => [row.provider, row.state]),
    [['garmin', 'ambiguous']],
    'only the confirmed delivery record goes',
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM job WHERE state='queued'").get()?.n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM job WHERE state='done'").get()?.n, 0);
  assert.deepEqual(
    Buffer.from(
      Schema.decodeUnknownSync(Schema.instanceOf(Uint8Array))(
        db.prepare('SELECT fit FROM activity WHERE id=?').get(id)?.fit,
      ),
    ),
    fit,
  );
  assert.ok(existsSync(resolve(activity, 'activity.fit')));
  assert.ok(existsSync(resolve(activity, 'chart.json')));
  assert.ok(existsSync(resolve(folder, 'activities', 'orphaned', '3 - 2026-08-15-09-10-45.fit')));
  assert.ok(existsSync(resolve(activity, 'videos', `${fresh}.mp4`)), 'a recent reservation stays');
  assert.ok(existsSync(resolve(folder, 'recent.tmp')));
  assert.ok(existsSync(resolve(folder, 'ride-recovery.bin')));
  assert.ok(existsSync(resolve(folder, 'ghosts', '6', '1', 'b.bin')));

  const again = await Effect.runPromise(service.plan());
  assert.equal(again.files.length, 0);
});

await test('a cleanup that stops between file removals completes on the next run', async (t) => {
  const { f, service } = await storage(t);
  const plan = await Effect.runPromise(service.plan());
  let removals = 0;
  const original = AssetFiles.prototype.removeTreeAsync;

  const stop = t.mock.method(AssetFiles.prototype, 'removeTreeAsync', async function (this: AssetFiles, path: string) {
    if (++removals > 2) {
      throw new Error('stopped');
    }
    await original.call(this, path);
  });

  await assert.rejects(Effect.runPromise(service.apply(plan)), /stopped/);
  stop.mock.restore();
  await Effect.runPromise(service.apply(await Effect.runPromise(service.plan())));
  const after = await Effect.runPromise(service.plan());
  assert.equal(after.files.length, 0);
  assert.equal(after.media.length, 0);
  assert.equal(f.accounts.db.prepare("SELECT count(*) AS n FROM activity_media WHERE state='reserved'").get()?.n, 1);
});

await test('storage use is reported by category', async (t) => {
  const { service } = await storage(t);
  const usage = await Effect.runPromise(service.usage());

  assert.ok(usage.database > 0);
  assert.ok(usage.media > 0);
  assert.ok(usage.fitExports > 0);
  assert.ok(usage.charts > 0);
  assert.ok(usage.ghosts > 0);
  assert.ok(usage.backups > 0);
});

await test('a media row is ready only after its file is durable', async (t) => {
  const f = await mediumFixture(t);

  const response = await f.request(`/api/profiles/${f.rider.player_id}/activities`, {
    method: 'POST',
    ...binary(ActivitySchema, {
      playerId: BigInt(f.rider.player_id),
      courseId: 6n,
      name: 'x',
      startDate: '2026-11-01',
    }),
  });

  const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(await response.json());

  const failing = t.mock.method(AssetFiles.prototype, 'writeDurableAsync', () =>
    Promise.reject(new Error('disk full')),
  );

  await assert.rejects(
    f.effects.runPromise(
      ActivitiesService.use((service) => service.saveImage(f.rider.player_id, String(id), new Uint8Array([1]))),
    ),
    /disk full/,
  );
  failing.mock.restore();
  assert.equal(f.accounts.db.prepare('SELECT state FROM activity_image').get()?.state, 'failed');

  const image = await f.effects.runPromise(
    ActivitiesService.use((service) => service.saveImage(f.rider.player_id, String(id), new Uint8Array([1]))),
  );

  assert.equal(f.accounts.db.prepare('SELECT state FROM activity_image WHERE id=?').get(image)?.state, 'ready');
  assert.equal(new AssetFiles().existsSync(resolve(activityFolderOf(f, id), 'images', `${image}.jpg`)), true);
});

await test('an upload published while retention scans keeps its row and file', async (t) => {
  const { f, id, activity, service } = await storage(t);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const original = AssetFiles.prototype.entriesAsync;
  let paused = false;
  t.mock.method(AssetFiles.prototype, 'entriesAsync', async function (this: AssetFiles, path: string) {
    if (!paused) {
      paused = true;
      entered.resolve();
      await resume.promise;
    }
    return original.call(this, path);
  });
  const planning = Effect.runPromise(service.plan());
  await entered.promise;
  const image = await f.effects.runPromise(
    ActivitiesService.use((uploads) => uploads.saveImage(f.rider.player_id, String(id), new Uint8Array([1]))),
  );
  resume.resolve();
  const plan = await planning;
  const path = resolve(activity, 'images', `${image}.jpg`);
  assert.ok(
    plan.files.some((file) => file.path === path),
    'the scan used its earlier ownership snapshot',
  );
  await Effect.runPromise(service.apply(plan));
  assert.ok(existsSync(path));
  assert.equal(f.accounts.db.prepare('SELECT state FROM activity_image WHERE id=?').get(image)?.state, 'ready');
});

await test('a reservation completed after preview survives cleanup for images and videos', async (t) => {
  const { f, id, activity, reserved, service } = await storage(t);
  const repository = f.accounts.repositories.activitiesRepository;
  const image = Number(repository.insertActivityImage(f.rider.player_id, id).lastInsertRowid);
  f.accounts.db.prepare('UPDATE activity_image SET created_at=? WHERE id=?').run(Date.now() - day, image);
  const path = resolve(activity, 'images', `${image}.jpg`);
  write(path);
  const plan = await Effect.runPromise(service.plan());
  assert.ok(plan.media.some((row) => row.table === 'activity_image' && row.id === image));
  assert.ok(repository.mediaState('activity_image', image, 'ready'));
  assert.ok(repository.mediaState('activity_media', reserved, 'ready'));
  await Effect.runPromise(service.apply(plan));
  assert.ok(existsSync(path));
  assert.ok(existsSync(resolve(activity, 'videos', `${reserved}.mp4`)));
  assert.equal(f.accounts.db.prepare('SELECT state FROM activity_image WHERE id=?').get(image)?.state, 'ready');
  assert.equal(repository.findActivityMedia(reserved)?.state, 'ready');
});

await test('cleanup preserves a file replaced after preview', async (t) => {
  const { activity, service } = await storage(t);
  const path = resolve(activity, 'images', '999.jpg');
  const plan = await Effect.runPromise(service.plan());
  new AssetFiles().writeDurable(path, 'replacement', true);
  await Effect.runPromise(service.apply(plan));
  assert.equal(readFileSync(path, 'utf8'), 'replacement');
});

await test('an in-flight upload cannot complete a reservation removed by cleanup', async (t) => {
  const { f, id, activity, service } = await storage(t);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const original = AssetFiles.prototype.writeDurableAsync;
  let path = '';
  t.mock.method(
    AssetFiles.prototype,
    'writeDurableAsync',
    async function (this: AssetFiles, target: string, data: string | Uint8Array, replace = false) {
      path = target;
      entered.resolve();
      await resume.promise;
      return original.call(this, target, data, replace);
    },
  );
  const uploading = f.effects.runPromise(
    ActivitiesService.use((uploads) => uploads.saveImage(f.rider.player_id, String(id), new Uint8Array([1]))),
  );
  const rejected = assert.rejects(uploading);
  await entered.promise;
  f.accounts.db.prepare('UPDATE activity_image SET created_at=?').run(Date.now() - day);
  const plan = await Effect.runPromise(service.plan());
  assert.ok(plan.media.some((row) => row.table === 'activity_image'));
  await Effect.runPromise(service.apply(plan));
  resume.resolve();
  await rejected;
  assert.ok(path.startsWith(resolve(activity, 'images')));
  assert.equal(existsSync(path), false);
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM activity_image').get()?.n, 0);
});

await test('a removal failure cannot restore a reservation after deleting its file', async (t) => {
  const { f, id, service } = await storage(t);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const write = AssetFiles.prototype.writeDurableAsync;
  let path = '';
  t.mock.method(
    AssetFiles.prototype,
    'writeDurableAsync',
    async function (this: AssetFiles, target: string, data: string | Uint8Array, replace = false) {
      await write.call(this, target, data, replace);
      path = target;
      entered.resolve();
      await resume.promise;
    },
  );
  const uploading = f.effects.runPromise(
    ActivitiesService.use((uploads) => uploads.saveImage(f.rider.player_id, String(id), new Uint8Array([1]))),
  );
  const rejected = assert.rejects(uploading);
  await entered.promise;
  f.accounts.db.prepare('UPDATE activity_image SET created_at=?').run(Date.now() - day);
  const plan = await Effect.runPromise(service.plan());
  const remove = AssetFiles.prototype.removeUnchanged;
  t.mock.method(
    AssetFiles.prototype,
    'removeUnchanged',
    function (this: AssetFiles, target: string, identity: string, eligible: () => boolean) {
      const removed = remove.call(this, target, identity, eligible);
      if (target === path && removed) {
        throw new Error('removal interrupted');
      }
      return removed;
    },
  );
  await assert.rejects(Effect.runPromise(service.apply(plan)), /removal interrupted/);
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM activity_image').get()?.n, 0);
  resume.resolve();
  await rejected;
  assert.equal(existsSync(path), false);
});
