import { WebSessionsService } from '#src/services/web-session.service';
import { ActivitiesService } from '#src/services/activities.service';
import { JobsService } from '#src/services/jobs.service';
import { Effect } from 'effect';
import { ConnectionsService } from '#src/services/connections.service';
import { IntegrationsService } from '#src/services/integrations.service';
import { DocumentsService } from '#src/services/documents.service';
import { RecordDataService } from '#src/services/record-data.service';
import { StravaRepository } from '#src/repositories/strava.repository';
import { openRuntime } from '#src/runtime';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { UploadsRepository } from '#src/repositories/uploads.repository';
import { GarminRepository } from '#src/repositories/garmin.repository';
import { activityFolderOf, mediumFixture } from '#tests/medium/support';
import { create } from '@bufbuild/protobuf';
import { GarminClient } from 'garminconnect-js';
import type { LoginResult, Tokens, MfaState } from 'garminconnect-js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const tokens: Tokens = {
  oauth1: { oauth_token: 'test', oauth_token_secret: 'secret', domain: 'garmin.com' },
  oauth2: {
    scope: '',
    jti: '',
    token_type: 'Bearer',
    access_token: 'access',
    refresh_token: 'refresh',
    expires_in: 3600,
    refresh_token_expires_in: 7200,
    expires_at: 9_999_999_999,
    refresh_token_expires_at: 9_999_999_999,
  },
};

const mfa: MfaState = {
  flow: 'mobile',
  domain: 'garmin.com',
  cookies: [],
  mfaMethod: 'email',
  loginParams: { clientId: 'test', locale: 'en', service: 'test' },
};

/** A signed-in web session for the rider, as the web app's authorization routes see it. */
function webSession(f: Awaited<ReturnType<typeof mediumFixture>>) {
  const sessions = f.effects.runSync(WebSessionsService);
  const identity = f.accounts.identityOf(f.rider);
  const { id } = f.effects.runSync(sessions.create(identity));

  return {
    id,
    live: () => f.effects.runSync(sessions.current(id, identity)),
    end: () => f.effects.runSync(sessions.end(id)),
  };
}

await test('delivery records send once, retry failures manually and never recreate deleted records', async (t) => {
  const f = await mediumFixture(t);
  const uploads = new UploadsRepository(f.accounts.db);
  f.accounts.db.prepare('INSERT INTO activity (id, player_id) VALUES (1, ?)').run(f.rider.player_id);
  assert.equal(uploads.insert(1, 'runalyze'), true);
  assert.equal(uploads.insert(1, 'runalyze'), false);
  assert.equal(uploads.record(1, 'runalyze', 'attempt', 'sent', null), false);
  assert.equal(uploads.begin(1, 'runalyze', 'attempt'), true);
  assert.equal(uploads.begin(1, 'runalyze', 'other'), false);
  assert.equal(uploads.record(1, 'runalyze', 'other', 'sent', null), false);
  assert.equal(uploads.record(1, 'runalyze', 'attempt', 'failed', 'runalyze_400'), true);
  assert.equal(uploads.begin(1, 'runalyze', 'retry'), false);
  assert.deepEqual(uploads.retry(f.other.player_id, false), []);
  assert.deepEqual(uploads.retry(f.rider.player_id, false), [{ activity: 1, provider: 'runalyze' }]);
  assert.equal(uploads.begin(1, 'runalyze', 'retry'), true);
  assert.equal(uploads.interrupted(), 1);
  assert.equal(uploads.get(1, 'runalyze')?.state, 'ambiguous');
  assert.deepEqual(uploads.retry(f.rider.player_id, false), [], 'ambiguous deliveries need confirmation');
  assert.deepEqual(uploads.retry(f.rider.player_id, true), [{ activity: 1, provider: 'runalyze' }]);
  f.accounts.db.exec('DELETE FROM activity_upload');
  assert.equal(uploads.record(1, 'runalyze', 'retry', 'sent', null), false);
  assert.equal(uploads.status(f.rider.player_id).length, 0);
});

await test('the job runner finishes admitted work at close and admits nothing after', async (t) => {
  const f = await mediumFixture(t);
  const jobs = f.effects.runSync(JobsService);
  const gate = Promise.withResolvers<void>();
  let runs = 0;
  f.effects.runSync(
    jobs.register('retention', {
      concurrency: 1,
      attempts: 1,
      timeoutMs: 60_000,
      run: () =>
        Effect.promise(async () => {
          runs++;
          await gate.promise;
        }),
    }),
  );
  f.effects.runSync(jobs.enqueue('retention', {}));
  f.effects.runSync(jobs.start());
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(runs, 1);
  const closing = f.effects.runPromise(jobs.close());
  f.effects.runSync(jobs.enqueue('retention', {}));
  gate.resolve();
  await closing;
  f.effects.runSync(jobs.start());
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(runs, 1);
  assert.deepEqual(
    f.accounts.repositories.jobsRepository.list('retention').map((job) => job.state),
    ['done', 'queued'],
  );
});

await test('media upload claims serialize requests and deletion during body read cannot recreate a file', async (t) => {
  const f = await mediumFixture(t);

  const activity = create(ActivitySchema, {
    courseId: 6n,
    name: 'Test',
    startDate: '2026-11-14T08:00:00Z',
    playerId: BigInt(f.rider.player_id),
  });

  const id = f.effects.runSync(
    RecordDataService.use((service) => service.insert('activity', ActivitySchema, activity, ['fit'])),
  );

  const media = f.effects.runSync(
    ActivitiesService.use((service) => service.insertActivityMedia(f.rider.player_id, id, 'video/mp4')),
  ).lastInsertRowid;

  const issued = f.effects.runSync(ActivitiesService.use((service) => service.issueMedia(String(media))));
  const gate = Promise.withResolvers<ArrayBuffer>();

  const uploading = f.effects.runPromise(
    ActivitiesService.use((service) => service.receiveMedia(String(media), issued.token, () => gate.promise)),
  );

  await assert.rejects(
    f.effects.runPromise(
      ActivitiesService.use((service) =>
        service.receiveMedia(String(media), issued.token, () => Promise.resolve(new ArrayBuffer(1))),
      ),
    ),
    { status: 403 },
  );
  const folder = activityFolderOf(f, id);
  f.effects.runSync(ActivitiesService.use((service) => service.deleteActivity(BigInt(id), f.rider.player_id)));
  gate.resolve(new ArrayBuffer(1));
  await assert.rejects(uploading, { status: 404 });
  assert.equal(existsSync(resolve(folder, 'videos', `${media}.mp4`)), false);
});

await test('failed media body reads release the claim; successful uploads consume it', async (t) => {
  const f = await mediumFixture(t);

  const id = f.effects.runSync(
    RecordDataService.use((service) =>
      service.insert(
        'activity',
        ActivitySchema,
        create(ActivitySchema, {
          courseId: 6n,
          name: 'Test',
          startDate: '2026-11-14T08:00:00Z',
          playerId: BigInt(f.rider.player_id),
        }),
        ['fit'],
      ),
    ),
  );

  const media = f.effects.runSync(
    ActivitiesService.use((service) => service.insertActivityMedia(f.rider.player_id, id, 'video/mp4')),
  ).lastInsertRowid;

  const issued = f.effects.runSync(ActivitiesService.use((service) => service.issueMedia(String(media))));
  await assert.rejects(
    f.effects.runPromise(
      ActivitiesService.use((service) =>
        service.receiveMedia(String(media), issued.token, () => Promise.reject(new Error('read failed'))),
      ),
    ),
    /read failed/,
  );
  await f.effects.runPromise(
    ActivitiesService.use((service) =>
      service.receiveMedia(String(media), issued.token, () => Promise.resolve(new ArrayBuffer(2))),
    ),
  );
  await assert.rejects(
    f.effects.runPromise(
      ActivitiesService.use((service) =>
        service.receiveMedia(String(media), issued.token, () => Promise.resolve(new ArrayBuffer(1))),
      ),
    ),
    { status: 403 },
  );
});

await test('browser continuation requires the same session and current identity version', async (t) => {
  const f = await mediumFixture(t);
  const opened = f.sessions.open();
  const identity = f.accounts.identityOf(f.rider);
  f.sessions.transition(opened.session, { type: 'login', identity });
  f.sessions.transition(opened.session, { type: 'clear-selection' });
  assert.equal(opened.session.selected, false);
  assert.equal(opened.session.identity, identity);
  assert.equal(f.sessions.current(opened.id, opened.session, identity), true);
  await f.accounts.changePassword(f.rider.player_id, 'changed');
  assert.equal(f.sessions.current(opened.id, opened.session, identity), false);
  f.sessions.end(opened.id);
  assert.equal(f.sessions.current(opened.id, opened.session, identity), false);
});

await test('Garmin MFA consumes one code and persists compatible tokens only for the current attempt', async (t) => {
  const f = await mediumFixture(t);
  const opened = webSession(f);
  f.effects.runSync(
    ConnectionsService.use((service) => service.save(f.rider.player_id, 'garmin', ['test', 'password'])),
  );
  t.mock.method(
    GarminClient.prototype,
    'login',
    (): Promise<LoginResult> => Promise.resolve({ state: 'mfa_required', mfaState: mfa }),
  );
  t.mock.method(GarminClient.prototype, 'resumeLogin', function (this: GarminClient) {
    this.setTokens(tokens);

    return Promise.resolve();
  });
  assert.equal(
    await f.effects.runPromise(
      IntegrationsService.use((service) => service.authorizeGarminSession(opened.id, opened.live, f.rider)),
    ),
    'mfa',
  );
  assert.equal(
    await f.effects.runPromise(
      IntegrationsService.use((service) => service.authorizeGarminSession(opened.id, opened.live, f.rider, '123')),
    ),
    'authorized',
  );
  assert.deepEqual(
    JSON.parse(
      f.effects.runSync(
        DocumentsService.use((service) => service.text(f.rider.player_id, 'garth/oauth1_token.json')),
      ) ?? '',
    ),
    tokens.oauth1,
  );
  await assert.rejects(
    f.effects.runPromise(
      IntegrationsService.use((service) => service.authorizeGarminSession(opened.id, opened.live, f.rider, '123')),
    ),
    /Expired/,
  );
});

await test('an obsolete Garmin login cannot publish tokens or erase the newer MFA attempt', async (t) => {
  const f = await mediumFixture(t);
  const opened = webSession(f);
  f.effects.runSync(
    ConnectionsService.use((service) => service.save(f.rider.player_id, 'garmin', ['test', 'password'])),
  );
  const gate = Promise.withResolvers<LoginResult>();
  let calls = 0;
  t.mock.method(GarminClient.prototype, 'login', function (this: GarminClient): Promise<LoginResult> {
    this.setTokens(tokens);

    return ++calls === 1 ? gate.promise : Promise.resolve({ state: 'mfa_required', mfaState: mfa });
  });
  const publish = t.mock.method(GarminRepository.prototype, 'saveAuthorization');

  const old = f.effects.runPromise(
    IntegrationsService.use((service) => service.authorizeGarminSession(opened.id, opened.live, f.rider)),
  );

  assert.equal(
    await f.effects.runPromise(
      IntegrationsService.use((service) => service.authorizeGarminSession(opened.id, opened.live, f.rider)),
    ),
    'mfa',
  );
  gate.resolve({ state: 'success', ...tokens });
  await assert.rejects(old, /Expired/);
  assert.equal(publish.mock.callCount(), 0);
  t.mock.method(GarminClient.prototype, 'resumeLogin', () => Promise.resolve());
  assert.equal(
    await f.effects.runPromise(
      IntegrationsService.use((service) => service.authorizeGarminSession(opened.id, opened.live, f.rider, '123')),
    ),
    'authorized',
  );
  assert.equal(publish.mock.callCount(), 1);
});

for (const reason of ['expiry', 'logout', 'password', 'disconnect'] as const) {
  await test(`Garmin continuation rejects ${reason}`, async (t) => {
    const f = await mediumFixture(t);
    const opened = webSession(f);
    f.effects.runSync(
      ConnectionsService.use((service) => service.save(f.rider.player_id, 'garmin', ['test', 'password'])),
    );
    t.mock.method(
      GarminClient.prototype,
      'login',
      (): Promise<LoginResult> => Promise.resolve({ state: 'mfa_required', mfaState: mfa }),
    );
    assert.equal(
      await f.effects.runPromise(
        IntegrationsService.use((service) => service.authorizeGarminSession(opened.id, opened.live, f.rider)),
      ),
      'mfa',
    );

    switch (reason) {
      case 'expiry': {
        const now = Date.now();
        t.mock.method(Date, 'now', () => now + 300_001);
        break;
      }

      case 'logout': {
        opened.end();
        break;
      }

      case 'password': {
        await f.accounts.changePassword(f.rider.player_id, 'changed');
        break;
      }

      case 'disconnect': {
        f.effects.runSync(ConnectionsService.use((service) => service.remove(f.rider.player_id, 'garmin')));
        break;
      }
      // No default
    }

    const resume = t.mock.method(GarminClient.prototype, 'resumeLogin', () => Promise.resolve());
    await assert.rejects(
      f.effects.runPromise(
        IntegrationsService.use((service) => service.authorizeGarminSession(opened.id, opened.live, f.rider, '123')),
      ),
      /Expired/,
    );
    assert.equal(resume.mock.callCount(), 0);
  });
}

await test('Strava authorization cannot publish a token after web sign-out', async (t) => {
  const f = await mediumFixture(t);
  const opened = webSession(f);
  f.effects.runSync(
    ConnectionsService.use((service) => service.save(f.rider.player_id, 'strava', ['client', 'secret'])),
  );
  const gate = Promise.withResolvers<void>();
  t.mock.method(StravaRepository.prototype, 'exchangeCode', async () => {
    await gate.promise;

    return {
      clientId: 'client',
      clientSecret: 'secret',
      access: 'access',
      refresh: 'refresh',
      expiresAt: 9_999_999_999,
    };
  });

  const pending = f.effects.runPromise(
    IntegrationsService.use((service) => service.authorizeStravaSession(opened.live, f.rider, 'code')),
  );

  opened.end();
  gate.resolve();
  await assert.rejects(pending, /Expired/);
  assert.equal(
    f.effects.runSync(DocumentsService.use((service) => service.has(f.rider.player_id, 'strava_token.txt'))),
    false,
  );
});

await test('partially opened runtimes release storage ownership and close is idempotent', async (t) => {
  const f = await mediumFixture(t);

  const fail = t.mock.method(UploadsRepository.prototype, 'interrupted', () => {
    throw new Error('worker start');
  });

  await assert.rejects(openRuntime(f.config, f.assets), /worker start/);
  fail.mock.restore();
  const runtime = await openRuntime(f.config, f.assets);
  const closing = runtime.close();
  assert.equal(runtime.close(), closing);
  await closing;
  const reopened = await openRuntime(f.config, f.assets);
  await reopened.close();
});

await test('runtime cleanup releases the storage lock even when an earlier service close fails', async (t) => {
  const f = await mediumFixture(t);
  const owner = await openRuntime(f.config, f.assets);
  const jobs = owner.runtime.effects.runSync(JobsService);
  const close = jobs.close;
  t.mock.method(jobs, 'close', () => close().pipe(Effect.andThen(Effect.die(new Error('close failed')))));
  await assert.rejects(owner.close(), AggregateError);
  const reopened = await openRuntime(f.config, f.assets);
  await reopened.close();
});
