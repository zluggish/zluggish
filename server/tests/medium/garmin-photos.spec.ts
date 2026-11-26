import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { GarminRepository } from '#src/repositories/garmin.repository';
import { DocumentsService } from '#src/services/documents.service';
import { UploadsService } from '#src/services/uploads.service';
import { mediumFixture } from '#tests/medium/support';
import { create } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { TestContext } from 'node:test';
import { test } from 'node:test';

const fit = new Uint8Array(readFileSync(new URL('../fixtures/ride.fit', import.meta.url)));

const activity = create(ActivitySchema, { name: 'Ride', fit, fitFilename: 'ride.fit' });

/** A rider with Garmin authorization; the images that the created activity is given are collected. */
async function withImages(t: TestContext, created: string | null, refuse = false, photosEnabled = true) {
  const f = await mediumFixture(t);

  await f.effects.runPromise(
    DocumentsService.use((documents) => documents.put(f.rider.player_id, 'garth/oauth1_token.json', '{}')),
  );
  f.settings.save(f.rider.player_id, { 'uploads.garmin.photos.enabled': photosEnabled });

  const sent: Array<string> = [];
  const posted: Array<[string, ReadonlyArray<string>]> = [];

  t.mock.method(GarminRepository.prototype, 'uploadGarmin', (...call: Parameters<GarminRepository['uploadGarmin']>) => {
    sent.push(call[2]);

    return Promise.resolve(created);
  });
  t.mock.method(
    GarminRepository.prototype,
    'postActivityImages',
    (...call: Parameters<GarminRepository['postActivityImages']>) => {
      posted.push([call[2], call[3]]);

      return refuse ? Promise.reject(new Error('refused')) : Promise.resolve();
    },
  );

  return { f, sent, posted };
}

await test('the photos of the ride are added to the activity Garmin created, the videos of it are not', async (t) => {
  const { f, posted } = await withImages(t, '1234567890');

  await f.effects.runPromise(
    UploadsService.use((uploads) =>
      uploads.garmin(f.rider.player_id, activity, ['images/1.jpg', 'medias/2.mp4', 'images/3.jpg']),
    ),
  );

  assert.deepEqual(posted, [['1234567890', ['images/1.jpg', 'images/3.jpg']]]);
});

await test('a duplicate is not given photos: without the id of the activity there is nothing to add them to', async (t) => {
  const { f, posted } = await withImages(t, null);

  await f.effects.runPromise(
    UploadsService.use((uploads) => uploads.garmin(f.rider.player_id, activity, ['images/1.jpg'])),
  );

  assert.deepEqual(posted, []);
});

await test('photos that Garmin refuses do not fail the delivery of the activity', async (t) => {
  const { f, posted } = await withImages(t, '1234567890', true);
  const warnings: Array<string> = [];

  t.mock.method(f.world.lifecycle.log, 'warn', (event: string, message: string) => {
    if (event === 'upload.garmin_photos') {
      warnings.push(message);
    }
  });

  await f.effects.runPromise(
    UploadsService.use((uploads) => uploads.garmin(f.rider.player_id, activity, ['images/1.jpg'])),
  );

  assert.equal(posted.length, 1, 'the photos were attempted against the activity Garmin created');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /photos could not be added/);
});

await test('a rider who left the setting at its default gets the FIT file on Garmin and no photos', async (t) => {
  const { f, sent, posted } = await withImages(t, '1234567890', false, false);

  await f.effects.runPromise(
    UploadsService.use((uploads) => uploads.garmin(f.rider.player_id, activity, ['images/1.jpg', 'images/3.jpg'])),
  );

  assert.deepEqual(sent, ['ride.fit'], 'the activity itself was still uploaded');
  assert.deepEqual(posted, []);
});
