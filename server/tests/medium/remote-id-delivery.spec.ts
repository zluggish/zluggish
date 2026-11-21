import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { GarminRepository } from '#src/repositories/garmin.repository';
import { UploadsRepository } from '#src/repositories/uploads.repository';
import { ActivitiesService } from '#src/services/activities.service';
import { ConnectionsService } from '#src/services/connections.service';
import { DocumentsService } from '#src/services/documents.service';
import { JobsService } from '#src/services/jobs.service';
import { UploadsService } from '#src/services/uploads.service';
import { binary, mediumFixture } from '#tests/medium/support';
import { create } from '@bufbuild/protobuf';
import { Garmin } from 'garminconnect-js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Schema } from 'effect';

const fit = readFileSync(new URL('../fixtures/ride.fit', import.meta.url));

async function completed(f: Awaited<ReturnType<typeof mediumFixture>>) {
  const data = {
    playerId: BigInt(f.rider.player_id),
    courseId: 6n,
    name: 'Delivered',
    startDate: new Date().toISOString(),
    distanceInMeters: 3000,
    fitFilename: 'ride.fit',
    fit,
  };

  const response = await f.request(`/api/profiles/${f.rider.player_id}/activities`, {
    method: 'POST',
    ...binary(ActivitySchema, data),
  });

  const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Number }))(await response.json());

  await f.effects.runPromise(
    ActivitiesService.use((activities) => activities.finalize(create(ActivitySchema, { ...data, id: BigInt(id) }))),
  );

  return id;
}

await test('garmin: importActivity with a success id stores the remote id and the delivery is sent', async (t) => {
  const f = await mediumFixture(t);
  const tokens = { oauth_token: 't', oauth_token_secret: 's' };

  await f.effects.runPromise(
    DocumentsService.use((documents) =>
      documents.put(f.rider.player_id, 'garth/oauth1_token.json', JSON.stringify(tokens)),
    ),
  );

  await f.effects.runPromise(
    DocumentsService.use((documents) =>
      documents.put(
        f.rider.player_id,
        'garth/oauth2_token.json',
        JSON.stringify({
          scope: '',
          jti: '',
          token_type: 'Bearer',
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 3600,
          refresh_token_expires_in: 7200,
          expires_at: 9_999_999_999,
          refresh_token_expires_at: 9_999_999_999,
        }),
      ),
    ),
  );

  t.mock.method(Garmin.prototype, 'importActivity', () =>
    Promise.resolve({ detailedImportResult: { successes: [{ internalId: 777 }] } }),
  );

  const id = await completed(f);

  await f.effects.runPromise(JobsService.use((jobs) => jobs.drain()));

  const remote = new UploadsRepository(f.accounts.db).remoteIds([id], f.rider.player_id);

  assert.deepEqual(remote, [{ activity_id: id, provider: 'garmin', remote_id: '777' }]);

  const status = await f.effects.runPromise(UploadsService.use((uploads) => uploads.status(f.rider.player_id)));

  assert.equal(status[0]?.state, 'sent');
});

await test('garmin: importActivity without an id in the response stores nothing but the delivery is sent', async (t) => {
  const f = await mediumFixture(t);
  const tokens = { oauth_token: 't', oauth_token_secret: 's' };

  await f.effects.runPromise(
    DocumentsService.use((documents) =>
      documents.put(f.rider.player_id, 'garth/oauth1_token.json', JSON.stringify(tokens)),
    ),
  );

  await f.effects.runPromise(
    DocumentsService.use((documents) =>
      documents.put(
        f.rider.player_id,
        'garth/oauth2_token.json',
        JSON.stringify({
          scope: '',
          jti: '',
          token_type: 'Bearer',
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 3600,
          refresh_token_expires_in: 7200,
          expires_at: 9_999_999_999,
          refresh_token_expires_at: 9_999_999_999,
        }),
      ),
    ),
  );

  t.mock.method(Garmin.prototype, 'importActivity', () => Promise.resolve({ status: 'uploaded' }));

  const id = await completed(f);

  await f.effects.runPromise(JobsService.use((jobs) => jobs.drain()));

  const remote = new UploadsRepository(f.accounts.db).remoteIds([id], f.rider.player_id);

  assert.deepEqual(remote, []);

  const status = await f.effects.runPromise(UploadsService.use((uploads) => uploads.status(f.rider.player_id)));

  assert.equal(status[0]?.state, 'sent');
});

await test('intervals: a JSON response with an id stores the remote id and the delivery is sent', async (t) => {
  const f = await mediumFixture(t);

  await f.effects.runPromise(
    ConnectionsService.use((connections) => connections.save(f.rider.player_id, 'intervals', ['42', 'key'])),
  );

  t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ id: 'i42' })));

  const id = await completed(f);

  await f.effects.runPromise(JobsService.use((jobs) => jobs.drain()));

  const remote = new UploadsRepository(f.accounts.db).remoteIds([id], f.rider.player_id);

  assert.deepEqual(remote, [{ activity_id: id, provider: 'intervals', remote_id: 'i42' }]);

  const status = await f.effects.runPromise(UploadsService.use((uploads) => uploads.status(f.rider.player_id)));

  assert.equal(status[0]?.state, 'sent');
});

await test('intervals: a non-JSON response stores nothing but the delivery is sent', async (t) => {
  const f = await mediumFixture(t);

  await f.effects.runPromise(
    ConnectionsService.use((connections) => connections.save(f.rider.player_id, 'intervals', ['42', 'key'])),
  );

  t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response('ok', { status: 200 })));

  const id = await completed(f);

  await f.effects.runPromise(JobsService.use((jobs) => jobs.drain()));

  const remote = new UploadsRepository(f.accounts.db).remoteIds([id], f.rider.player_id);

  assert.deepEqual(remote, []);

  const status = await f.effects.runPromise(UploadsService.use((uploads) => uploads.status(f.rider.player_id)));

  assert.equal(status[0]?.state, 'sent');
});

await test('garmin: a failure to save the remote id leaves the delivery sent', async (t) => {
  const f = await mediumFixture(t);

  await f.effects.runPromise(
    DocumentsService.use((documents) =>
      documents.put(
        f.rider.player_id,
        'garth/oauth1_token.json',
        JSON.stringify({ oauth_token: 't', oauth_token_secret: 's' }),
      ),
    ),
  );

  t.mock.method(UploadsRepository.prototype, 'setRemote', () => {
    throw new Error('database is locked');
  });

  t.mock.method(GarminRepository.prototype, 'uploadGarmin', () => Promise.resolve('777'));

  const id = await completed(f);

  await f.effects.runPromise(JobsService.use((jobs) => jobs.drain()));

  const status = await f.effects.runPromise(UploadsService.use((uploads) => uploads.status(f.rider.player_id)));

  assert.equal(status[0]?.state, 'sent');
  assert.deepEqual(new UploadsRepository(f.accounts.db).remoteIds([id], f.rider.player_id), []);
});
