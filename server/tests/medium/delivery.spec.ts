import { ActivitiesService } from '#src/services/activities.service';
import { JobsService } from '#src/services/jobs.service';
import { ConnectionsService } from '#src/services/connections.service';
import { DocumentsService } from '#src/services/documents.service';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import { DeliveryRefusedError } from '#src/errors';
import { ZwiftRepository } from '#src/repositories/zwift.repository';
import { UploadsService } from '#src/services/uploads.service';
import { activityFolderOf, binary, mediumFixture } from '#tests/medium/support';
import { create, toBinary } from '@bufbuild/protobuf';
import { Garmin, GarminAuthError, GarminConnectionError, GarminHttpError } from 'garminconnect-js';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Schema } from 'effect';

const fit = readFileSync(new URL('../fixtures/ride.fit', import.meta.url));

type Fixture = Awaited<ReturnType<typeof mediumFixture>>;

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

  const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(await response.json());
  f.effects.runSync(
    ActivitiesService.use((service) => service.finalize(create(ActivitySchema, { ...data, id: BigInt(id) }))),
  );

  return id;
}

const reset = () =>
  Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }));

for (const [outcome, response, state] of [
  ['confirmed success', () => Promise.resolve(new Response(null, { status: 200 })), 'sent'],
  ['a rejection', () => Promise.resolve(new Response(null, { status: 400 })), 'failed'],
  ['a server error after the request', () => Promise.resolve(new Response(null, { status: 503 })), 'ambiguous'],
  ['remote acceptance with a lost response', reset, 'ambiguous'],
  ['a connection reset', reset, 'ambiguous'],
  ['a timeout', () => Promise.reject(new DOMException('The operation timed out', 'TimeoutError')), 'ambiguous'],
] as const) {
  await test(`a delivery with ${outcome} becomes ${state} and never sends twice on its own`, async (t) => {
    const f = await mediumFixture(t);
    f.effects.runSync(DocumentsService.use((service) => service.put(f.rider.player_id, 'runalyze_token.txt', 'token')));
    await completed(f);
    const sends = t.mock.method(globalThis, 'fetch', response);
    await f.effects.runPromise(JobsService.use((service) => service.drain()));
    assert.equal(
      f.effects.runSync(UploadsService.use((service) => service.status(f.rider.player_id)))[0]?.state,
      state,
    );
    await f.effects.runPromise(JobsService.use((service) => service.drain()));
    assert.equal(sends.mock.callCount(), 1);
  });
}

await test('a stop during each delivery state never sends a delivery twice', async (t) => {
  const f = await mediumFixture(t);
  f.effects.runSync(DocumentsService.use((service) => service.put(f.rider.player_id, 'runalyze_token.txt', 'token')));
  const id = await completed(f);
  const sends = t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(null, { status: 200 })));

  // Stopped while sending: the restart records an unknown result and does not send.
  f.accounts.db.prepare("UPDATE activity_upload SET state='sending', attempt='lost' WHERE activity_id=?").run(id);
  f.effects.runSync(UploadsService.use((service) => service.start()));
  await f.effects.runPromise(JobsService.use((service) => service.drain()));
  assert.equal(
    f.effects.runSync(UploadsService.use((service) => service.status(f.rider.player_id)))[0]?.state,
    'ambiguous',
  );
  assert.equal(sends.mock.callCount(), 0);

  // Stopped while pending: the queued job sends once after the restart.
  f.accounts.db.prepare("UPDATE activity_upload SET state='pending' WHERE activity_id=?").run(id);
  f.accounts.repositories.jobsRepository.enqueue('delivery', { activityId: id, provider: 'runalyze' });
  f.effects.runSync(UploadsService.use((service) => service.start()));
  await f.effects.runPromise(JobsService.use((service) => service.drain()));
  assert.equal(sends.mock.callCount(), 1);

  // Stopped after a result: neither sent nor failed deliveries run again.
  for (const final of ['sent', 'failed']) {
    f.accounts.db.prepare('UPDATE activity_upload SET state=? WHERE activity_id=?').run(final, id);
    f.accounts.repositories.jobsRepository.enqueue('delivery', { activityId: id, provider: 'runalyze' });
    f.effects.runSync(UploadsService.use((service) => service.start()));
    await f.effects.runPromise(JobsService.use((service) => service.drain()));
  }

  assert.equal(sends.mock.callCount(), 1);
});

await test('a rider uploads a finished activity on request, and uploads it again only when confirmed', async (t) => {
  const f = await mediumFixture(t);
  const player = f.rider.player_id;
  const id = await completed(f);
  const sends = t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(null, { status: 200 })));
  const uploads = f.effects.runSync(UploadsService);

  // Nothing was connected when the activity finished, so it has no deliveries yet.
  assert.deepEqual(f.effects.runSync(uploads.forActivity(player, id)), []);
  await assert.rejects(f.effects.runPromise(uploads.request(player, id, 'runalyze', false)), { status: 409 });

  f.effects.runSync(DocumentsService.use((service) => service.put(player, 'runalyze_token.txt', 'token')));
  assert.deepEqual(f.effects.runSync(uploads.forActivity(player, id)), [
    { provider: 'runalyze', state: null, error: null },
  ]);
  await assert.rejects(f.effects.runPromise(uploads.request(f.other.player_id, id, 'runalyze', false)), {
    status: 404,
  });

  await f.effects.runPromise(uploads.request(player, id, 'runalyze', false));
  assert.equal(f.effects.runSync(uploads.forActivity(player, id))[0]?.state, 'sent');
  await assert.rejects(f.effects.runPromise(uploads.request(player, id, 'runalyze', false)), { status: 409 });
  assert.equal(sends.mock.callCount(), 1);

  await f.effects.runPromise(uploads.request(player, id, 'runalyze', true));
  assert.equal(f.effects.runSync(uploads.forActivity(player, id))[0]?.state, 'sent');
  assert.equal(sends.mock.callCount(), 2);
});

await test('finished activities without completion records upload, while unfinished activities stay blocked', async (t) => {
  const f = await mediumFixture(t);
  const player = f.rider.player_id;
  const id = await completed(f);
  f.accounts.db.prepare('DELETE FROM activity_completion WHERE activity_id=?').run(id);
  f.accounts.db.prepare('UPDATE activity SET end_date=? WHERE id=?').run(new Date().toISOString(), id);
  f.effects.runSync(DocumentsService.use((service) => service.put(player, 'runalyze_token.txt', 'token')));
  const sends = t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(null, { status: 200 })));

  await f.effects.runPromise(UploadsService.use((service) => service.request(player, id, 'runalyze', false)));
  assert.equal(f.effects.runSync(UploadsService.use((service) => service.forActivity(player, id)))[0]?.state, 'sent');
  assert.equal(sends.mock.callCount(), 1);
  assert.equal(f.accounts.repositories.completionRepository.get(BigInt(id)), null);

  f.accounts.db.prepare('UPDATE activity SET end_date=NULL WHERE id=?').run(id);
  await assert.rejects(
    f.effects.runPromise(UploadsService.use((service) => service.request(player, id, 'runalyze', true))),
    { status: 409 },
  );
  f.accounts.db.prepare('UPDATE activity SET end_date=?, fit=NULL WHERE id=?').run(new Date().toISOString(), id);
  await assert.rejects(
    f.effects.runPromise(UploadsService.use((service) => service.request(player, id, 'runalyze', true))),
    { status: 409 },
  );
  assert.equal(sends.mock.callCount(), 1);
});

await test('uploads.intervals.enabled off keeps the connection but stops finished activity uploads', async (t) => {
  const f = await mediumFixture(t);
  const player = f.rider.player_id;
  const saveConnection = () =>
    f.effects.runSync(ConnectionsService.use((service) => service.save(player, 'intervals', ['i123', 'key'])));

  f.settings.save(player, { 'uploads.intervals.enabled': false });
  saveConnection();
  await completed(f);
  const sends = t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(null, { status: 200 })));
  await f.effects.runPromise(JobsService.use((service) => service.drain()));

  assert.equal(
    f.accounts.db.prepare("SELECT COUNT(*) AS count FROM activity_upload WHERE provider='intervals'").get()?.count,
    0,
  );
  assert.equal(sends.mock.callCount(), 0);

  const configured = () => f.effects.runSync(UploadsService.use((service) => service.configured(player)));
  assert.equal(configured().includes('intervals'), false);
  assert.equal(f.accounts.repositories.connectionsRepository.has(player, 'intervals'), true);

  f.settings.save(player, {});
  assert.ok(configured().includes('intervals'));

  const id = await completed(f);
  f.accounts.repositories.uploadsRepository.insert(id, 'intervals');
  f.accounts.db.prepare("UPDATE activity_upload SET state='pending' WHERE provider='intervals'").run();
  f.settings.save(player, { 'uploads.intervals.enabled': false });
  f.effects.runSync(UploadsService.use((service) => service.revoke(player)));
  assert.equal(
    f.effects.runSync(UploadsService.use((service) => service.status(player))).find((row) => row.activity_id === id)
      ?.state,
    'cancelled',
  );
});

await test('a partial Zwift delivery keeps its remote activity and a retry uploads to it', async (t) => {
  const f = await mediumFixture(t);
  f.effects.runSync(ConnectionsService.use((service) => service.save(f.rider.player_id, 'zwift', ['user', 'pass'])));
  f.settings.save(f.rider.player_id, { 'uploads.zwift.enabled': true });
  t.mock.method(ZwiftRepository.prototype, 'officialLogin', () => Promise.resolve('token'));
  await completed(f);
  const calls: Array<string> = [];
  let uploads = 0;

  t.mock.method(globalThis, 'fetch', (input: string | URL, init?: RequestInit) => {
    const call = `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`;
    calls.push(call);

    if (call.endsWith('/profiles/me')) {
      return Promise.resolve(new Response(toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 555n }))));
    }

    if (call.startsWith('POST')) {
      return Promise.resolve(Response.json({ id: 77 }));
    }

    return Promise.resolve(new Response(null, { status: ++uploads === 1 ? 503 : 200 }));
  });

  await f.effects.runPromise(JobsService.use((service) => service.drain()));
  const record = f.accounts.db.prepare('SELECT state, remote_id, step FROM activity_upload').get();
  assert.deepEqual({ ...record }, { state: 'ambiguous', remote_id: '77', step: 'created' });

  await f.effects.runPromise(UploadsService.use((service) => service.retry(f.rider.player_id, true)));
  assert.equal(f.effects.runSync(UploadsService.use((service) => service.status(f.rider.player_id)))[0]?.state, 'sent');
  assert.deepEqual(
    calls.filter((call) => !call.endsWith('/profiles/me')),
    ['POST /api/profiles/555/activities', 'PUT /api/profiles/555/activities/77', 'PUT /api/profiles/555/activities/77'],
  );
});

await test('deleting every FIT export breaks neither details, charts nor delivery; a job creates them again', async (t) => {
  const f = await mediumFixture(t);
  f.effects.runSync(DocumentsService.use((service) => service.put(f.rider.player_id, 'runalyze_token.txt', 'token')));
  const delivered: Array<Uint8Array> = [];
  t.mock.method(globalThis, 'fetch', async (_input: string | URL, init?: RequestInit) => {
    const file = Schema.decodeUnknownSync(Schema.instanceOf(FormData))(init?.body).get('file');
    delivered.push(new Uint8Array(await Schema.decodeUnknownSync(Schema.instanceOf(Blob))(file).arrayBuffer()));

    return new Response(null, { status: 200 });
  });
  const id = await completed(f);
  const folder = activityFolderOf(f, id);
  await f.effects.runPromise(JobsService.use((service) => service.drain()));
  assert.deepEqual(readdirSync(folder).toSorted(), ['activity.fit', 'chart.json']);
  rmSync(resolve(folder, 'activity.fit'));
  rmSync(resolve(folder, 'chart.json'));

  f.accounts.db.exec("UPDATE activity_upload SET state='failed'");
  await f.effects.runPromise(UploadsService.use((service) => service.retry(f.rider.player_id)));
  assert.equal(delivered.length, 2);
  assert.deepEqual(Buffer.from(delivered[1] ?? []), fit);

  const details = await f.request(`/api/activities/${id}`);
  assert.equal(details.status, 200);
  await f.effects.runPromise(JobsService.use((service) => service.drain()));

  const detail = await f.request(`/api/activities/${id}`);

  const ready = Schema.decodeUnknownSync(Schema.Struct({ fitnessData: Schema.Struct({ fullDataUrl: Schema.String }) }))(
    await detail.json(),
  );

  const chart = await f.request(new URL(ready.fitnessData.fullDataUrl).pathname);
  assert.equal(chart.status, 200);

  f.accounts.repositories.jobsRepository.enqueue('fit_export', { activityId: id });
  await f.effects.runPromise(JobsService.use((service) => service.drain()));
  assert.deepEqual(readFileSync(resolve(folder, 'activity.fit')), fit);
});

type Outcome = 'sent' | 'failed' | 'ambiguous';

/** The delivery state a provider call leads to: sent, failed (refused) or ambiguous. */
async function outcome(call: () => Promise<void>): Promise<Outcome> {
  try {
    await call();

    return 'sent';
  } catch (error) {
    return error instanceof DeliveryRefusedError ? 'failed' : 'ambiguous';
  }
}

const status = (code: number) => () => Promise.resolve(new Response(code === 200 ? '{}' : 'error', { status: code }));
const offline = () => Promise.reject(new TypeError('fetch failed'));

const activity = create(ActivitySchema, {
  playerId: 1n,
  courseId: 6n,
  name: 'Ride',
  startDate: '2026-11-01T10:00:00Z',
  fit,
  fitFilename: 'ride.fit',
});

for (const [provider, setup] of [
  [
    'runalyze',
    (f: Fixture) =>
      f.effects.runSync(
        DocumentsService.use((service) => service.put(f.rider.player_id, 'runalyze_token.txt', 'token')),
      ),
  ],
  [
    'intervals',
    (f: Fixture) =>
      f.effects.runSync(
        ConnectionsService.use((service) => service.save(f.rider.player_id, 'intervals', ['42', 'key'])),
      ),
  ],
  [
    'strava',
    (f: Fixture) =>
      f.effects.runSync(
        DocumentsService.use((service) =>
          service.put(f.rider.player_id, 'strava_token.txt', '1\nsecret\na\nr\n9999999999\n'),
        ),
      ),
  ],
] as const) {
  for (const [response, expected] of [
    [status(200), 'sent'],
    [status(400), 'failed'],
    [status(401), 'failed'],
    [status(409), 'failed'],
    [status(408), 'ambiguous'],
    [status(429), 'ambiguous'],
    [status(500), 'ambiguous'],
    [status(503), 'ambiguous'],
    [offline, 'ambiguous'],
  ] as const) {
    await test(`${provider}: ${response === offline ? 'a network failure' : 'a response'} becomes ${expected}`, async (t) => {
      const f = await mediumFixture(t);
      setup(f);
      t.mock.method(globalThis, 'fetch', response);
      const uploads = f.effects.runSync(UploadsService);
      assert.equal(await outcome(() => f.effects.runPromise(uploads[provider](f.rider.player_id, activity))), expected);
    });
  }
}

await test('every provider refuses a delivery without credentials, before any request', async (t) => {
  const f = await mediumFixture(t);
  const sends = t.mock.method(globalThis, 'fetch', status(200));
  const uploads = f.effects.runSync(UploadsService);
  const player = f.rider.player_id;

  for (const send of [
    () => f.effects.runPromise(uploads.runalyze(player, activity)),
    () => f.effects.runPromise(uploads.intervals(player, activity)),
    () => f.effects.runPromise(uploads.strava(player, activity)),
    () => f.effects.runPromise(uploads.freeStrava(player, activity, [])),
    () => f.effects.runPromise(uploads.garmin(player, activity)),
    () => f.effects.runPromise(uploads.zwift(player, activity)),
  ]) {
    assert.equal(await outcome(send), 'failed');
  }

  f.effects.runSync(ConnectionsService.use((service) => service.save(player, 'intervals', ['not-a-number', 'key'])));
  assert.equal(await outcome(() => f.effects.runPromise(uploads.intervals(player, activity))), 'failed');
  assert.equal(sends.mock.callCount(), 0);
});

await test('strava: a failed token refresh happens before the upload and is refused', async (t) => {
  const f = await mediumFixture(t);
  f.effects.runSync(
    DocumentsService.use((service) => service.put(f.rider.player_id, 'strava_token.txt', '1\nsecret\na\nr\n1\n')),
  );
  const calls = t.mock.method(globalThis, 'fetch', status(400));
  assert.equal(
    await outcome(() =>
      f.effects.runPromise(UploadsService.use((service) => service.strava(f.rider.player_id, activity))),
    ),
    'failed',
  );
  assert.equal(calls.mock.callCount(), 1, 'only the refresh request');
});

for (const [step, expected] of [
  ['the upload form cannot be read', 'failed'],
  ['the session is not valid', 'failed'],
  ['the upload request fails', 'ambiguous'],
] as const) {
  await test(`strava session cookie: ${step} becomes ${expected}`, async (t) => {
    const f = await mediumFixture(t);
    f.effects.runSync(
      DocumentsService.use((service) => service.put(f.rider.player_id, 'strava4_session.txt', 'cookie')),
    );

    t.mock.method(globalThis, 'fetch', (input: string | URL) => {
      const url = String(input);

      if (url.endsWith('/upload/select')) {
        return step === 'the upload form cannot be read'
          ? offline()
          : Promise.resolve(
              new Response(
                step === 'the session is not valid'
                  ? 'Log in'
                  : 'Upload and Sync Your Activities <meta name="csrf-token" content="token">',
              ),
            );
      }

      return offline();
    });

    assert.equal(
      await outcome(() =>
        f.effects.runPromise(UploadsService.use((service) => service.freeStrava(f.rider.player_id, activity, []))),
      ),
      expected,
    );
  });
}

for (const [error, expected] of [
  [new GarminConnectionError('Import error: duplicate', { cause: new GarminHttpError('dup', 409, 'u', '') }), 'sent'],
  [new GarminConnectionError('Import error: bad', { cause: new GarminHttpError('bad', 400, 'u', '') }), 'failed'],
  [new GarminConnectionError('Import error: server', { cause: new GarminHttpError('srv', 502, 'u', '') }), 'ambiguous'],
  [new GarminAuthError('expired'), 'failed'],
  [new GarminConnectionError('timeout'), 'ambiguous'],
] as const) {
  await test(`garmin: ${error.message} becomes ${expected}`, async (t) => {
    const f = await mediumFixture(t);
    const tokens = { oauth_token: 't', oauth_token_secret: 's' };
    f.effects.runSync(
      DocumentsService.use((service) =>
        service.put(f.rider.player_id, 'garth/oauth1_token.json', JSON.stringify(tokens)),
      ),
    );
    f.effects.runSync(
      DocumentsService.use((service) =>
        service.put(
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
    t.mock.method(Garmin.prototype, 'importActivity', () => Promise.reject(error));
    assert.equal(
      await outcome(() =>
        f.effects.runPromise(UploadsService.use((service) => service.garmin(f.rider.player_id, activity))),
      ),
      expected,
    );
  });
}

for (const [step, expected, creates] of [
  ['the login fails', 'failed', 0],
  ['the profile read is rejected', 'failed', 0],
  ['the creation is rejected', 'failed', 1],
  ['the creation response is lost', 'ambiguous', 1],
  ['the upload is rejected', 'failed', 1],
] as const) {
  await test(`zwift: ${step} becomes ${expected}`, async (t) => {
    const f = await mediumFixture(t);
    f.effects.runSync(ConnectionsService.use((service) => service.save(f.rider.player_id, 'zwift', ['user', 'pass'])));
    t.mock.method(ZwiftRepository.prototype, 'officialLogin', () =>
      step === 'the login fails' ? Promise.reject(new Error('login')) : Promise.resolve('token'),
    );

    let posts = 0;

    t.mock.method(globalThis, 'fetch', (input: string | URL, init?: RequestInit) => {
      if (String(input).endsWith('/profiles/me')) {
        return step === 'the profile read is rejected'
          ? status(401)()
          : Promise.resolve(new Response(toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 5n }))));
      }

      if (init?.method === 'POST') {
        posts++;

        if (step === 'the creation is rejected') {
          return status(400)();
        }

        return step === 'the creation response is lost' ? offline() : Promise.resolve(Response.json({ id: 77 }));
      }

      return step === 'the upload is rejected' ? status(400)() : status(200)();
    });

    assert.equal(
      await outcome(() =>
        f.effects.runPromise(UploadsService.use((service) => service.zwift(f.rider.player_id, activity))),
      ),
      expected,
    );
    assert.equal(posts, creates);
  });
}
