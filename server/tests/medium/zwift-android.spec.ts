import { ManagementService } from '#src/services/management.service';
import { TlsService } from '#src/services/tls.service';
import { zwiftAndroidChunkSize } from '#src/services/zwift-android.service';
import { mediumWeb } from '#tests/medium/support';
import { binaryManifest, zip } from '#tests/support/apk';
import { runtimeFixture } from '#tests/support/runtime';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

interface Activity {
  kind: string;
  state: string;
  step: string;
  steps: Array<string>;
  message: string | null;
}

await test('an administrator uploads a Zwift APKM in chunks and follows the build', async (t) => {
  const fixture = runtimeFixture(t);
  await fixture.effects.runPromise(fixture.effects.runSync(TlsService).start());
  const management = fixture.effects.runSync(ManagementService);
  const owner = await fixture.effects.runPromise(
    management.setup({
      mode: 'new',
      key: fixture.effects.runSync(management.issueSetupKey())!,
      username: 'owner',
      first_name: 'First',
      last_name: 'Rider',
      password: 'test-password',
    }),
  );
  const rider = await fixture.accounts.create('Android Rider', 'test-password', 'rider');
  const admin = mediumWeb(fixture, owner);
  const web = mediumWeb(fixture, rider);

  const empty = await web.request('/api/install/android');
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { app: null });
  const missing = await web.request('/api/install/android/app');
  assert.equal(missing.status, 404);

  const zwift = 'com.zwift.zwiftgame';
  const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
  const obb = zip([['dataES/cacert.pem', Buffer.from(pem + '# description\n'.repeat(256)), false]]);
  // Android 7 is too old for the standalone app, so the build stops at the check, before any Java tools download.
  const base = zip([['AndroidManifest.xml', binaryManifest(zwift, '1.24.0', 124, 24), false]]);
  const split = zip([['AndroidManifest.xml', binaryManifest(zwift, '1.24.0', 124, 24, 'config.arm64_v8a'), false]]);
  const apkm = zip([
    ['base.apk', base, false],
    ['split_config.arm64_v8a.apk', split, true],
    ['padding', Buffer.alloc(zwiftAndroidChunkSize), false],
    [`Android/obb/${zwift}/main.124.${zwift}.obb`, obb, true],
  ]);

  const uploads = '/api/manage/zwift-android/uploads';
  const metadata = { name: 'zwift.apkm', size: apkm.length };
  const denied = await web.request(uploads, 'POST', metadata);
  assert.equal(denied.status, 403);
  const wrongType = await admin.request(uploads, 'POST', { name: 'main.124.com.zwift.zwiftgame.obb', size: 10 });
  assert.equal(wrongType.status, 400);
  const tooLarge = await admin.request(uploads, 'POST', { name: 'zwift.apkm', size: 20_000_000_000 });
  assert.equal(tooLarge.status, 400);

  const abandoned = await admin.request(uploads, 'POST', metadata);
  assert.equal(abandoned.status, 201);
  const { id: abandonedId } = await abandoned.json();
  const abandonedUrl = `${uploads}/${abandonedId}`;
  // A reloaded page starts over: the newer upload replaces the abandoned one.
  const begin = await admin.request(uploads, 'POST', metadata);
  assert.equal(begin.status, 201);
  const { id } = await begin.json();
  const session = `${uploads}/${id}`;
  const replaced = await admin.request(`${abandonedUrl}?offset=0`, 'PUT', Buffer.alloc(10));
  assert.equal(replaced.status, 404);

  const firstChunk = apkm.subarray(0, zwiftAndroidChunkSize);
  const finalChunk = apkm.subarray(zwiftAndroidChunkSize);
  const ahead = await admin.request(`${session}?offset=${zwiftAndroidChunkSize}`, 'PUT', finalChunk);
  assert.equal(ahead.status, 409);
  const partial = await admin.request(`${session}?offset=0`, 'PUT', firstChunk.subarray(0, 100));
  assert.equal(partial.status, 400);
  const first = await admin.request(`${session}?offset=0`, 'PUT', firstChunk);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { id, offset: zwiftAndroidChunkSize, size: apkm.length });
  const repeated = await admin.request(`${session}?offset=0`, 'PUT', firstChunk);
  assert.equal(repeated.status, 200);
  const { offset: repeatedOffset } = await repeated.json();
  assert.equal(repeatedOffset, zwiftAndroidChunkSize);
  const final = await admin.request(`${session}?offset=${zwiftAndroidChunkSize}`, 'PUT', finalChunk);
  assert.equal(final.status, 200);
  const { offset: finalOffset } = await final.json();
  assert.equal(finalOffset, apkm.length);

  const settle = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await admin.request('/api/manage/zwift-android');
      assert.equal(response.status, 200);
      const status = await response.json();
      const activity: Activity = status.activity;
      if (activity.state !== 'running') {
        return { status, activity };
      }
      await sleep(20);
    }
    throw new Error('The build did not finish.');
  };

  const { status, activity } = await settle();
  assert.equal(activity.message !== null && /too old/.test(activity.message), true, activity.message ?? '');
  assert.equal(activity.state, 'failed');
  assert.equal(activity.kind, 'upload');
  assert.equal(activity.step, 'inspect');
  assert.deepEqual(activity.steps.slice(0, 3), ['extract', 'certificate', 'inspect']);
  assert.equal(status.app, null);
  assert.equal(status.disk.recommended, 10_000_000_000);
  assert.ok(status.disk.free === null || status.disk.free > 0);
  assert.equal(status.original.name, 'zwift.apkm');
  assert.equal(status.original.bytes, apkm.length);

  const originals = resolve(fixture.config.storageDir, 'zwift-android', 'originals');
  assert.deepEqual(await readdir(originals), [id]);
  assert.deepEqual(await readFile(resolve(originals, id, 'upload')), apkm);

  const riderRebuild = await web.request('/api/manage/zwift-android/rebuild', 'POST', {});
  assert.equal(riderRebuild.status, 403);
  const rebuild = await admin.request('/api/manage/zwift-android/rebuild', 'POST', {});
  assert.equal(rebuild.status, 202);
  const rebuilt = await settle();
  assert.equal(rebuilt.activity.state, 'failed');
  assert.equal(rebuilt.activity.kind, 'rebuild');
  assert.deepEqual(await readFile(resolve(originals, id, 'upload')), apkm);

  const second = await admin.request(uploads, 'POST', metadata);
  assert.equal(second.status, 201);
  const { id: secondId } = await second.json();
  const secondUrl = `${uploads}/${secondId}`;
  const cancelled = await admin.request(secondUrl, 'DELETE', {});
  assert.equal(cancelled.status, 200);
  assert.deepEqual(await cancelled.json(), { cancelled: true });
  const gone = await admin.request(`${secondUrl}?offset=0`, 'PUT', firstChunk);
  assert.equal(gone.status, 404);
});
