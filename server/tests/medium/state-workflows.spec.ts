import { StravaRepository } from '#src/repositories/strava.repository';
import { UploadsService } from '#src/services/uploads.service';
import { openRuntime } from '#src/runtime';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { Completions } from '#src/repositories/completion.repository';
import { UploadsRepository } from '#src/repositories/uploads.repository';
import { GarminRepository } from '#src/repositories/garmin.repository';
import { AssetFiles } from '#src/repositories/files.repository';
import { mediumFixture } from '#tests/medium/support';
import { create, toBinary } from '@bufbuild/protobuf';
import { GarminClient, type LoginResult, type Tokens, type MfaState } from 'garminconnect-js';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

await test('upload transitions claim once, require manual retry and never recreate deleted jobs', async (t) => {
  const f = await mediumFixture(t);
  const journal = new Completions(f.accounts.db);
  const uploads = new UploadsRepository(f.accounts.db);
  journal.prepare(1n, f.rider.player_id, new Uint8Array(), null);
  assert.equal(journal.state(1n).status, 'prepared');
  journal.complete(1n, ['runalyze'], () => {});
  assert.equal(journal.state(1n).status, 'completed');
  assert.equal(uploads.finish(1, 'runalyze', 'sent'), false);
  assert.equal(uploads.claim(1, 'runalyze'), true);
  assert.equal(uploads.claim(1, 'runalyze'), false);
  uploads.failInterrupted();
  assert.equal(uploads.claim(1, 'runalyze'), false);
  uploads.retry(f.other.player_id);
  assert.equal(uploads.claim(1, 'runalyze'), false);
  uploads.retry(f.rider.player_id);
  assert.equal(uploads.claim(1, 'runalyze'), true);
  f.accounts.db.exec('DELETE FROM activity_upload');
  assert.equal(uploads.finish(1, 'runalyze', 'sent'), false);
  assert.equal(uploads.status(f.rider.player_id).length, 0);
});

await test('upload worker shares draining and closing work and refuses work after close', async (t) => {
  const f = await mediumFixture(t);

  const activity = create(ActivitySchema, {
    courseId: 6n,
    name: 'Test',
    startDate: '2026-11-14T08:00:00Z',
    id: 1n,
    playerId: BigInt(f.rider.player_id),
    fitFilename: 'ride.fit',
  });

  const journal = new Completions(f.accounts.db);
  journal.prepare(1n, f.rider.player_id, toBinary(ActivitySchema, activity), null);
  journal.complete(1n, ['runalyze'], () => {});
  new AssetFiles().writeDurable(resolve(f.profiles.folder(f.rider.player_id), 'runalyze_token.txt'), 'test');
  const gate = Promise.withResolvers<void>();
  let deliveries = 0;
  t.mock.method(f.services.uploads, 'runalyze', async () => {
    deliveries++;
    await gate.promise;
  });
  const first = f.services.uploads.drain();
  assert.equal(f.services.uploads.drain(), first);
  assert.equal(f.services.uploads.workerStatus, 'draining');
  f.services.uploads.start();
  assert.equal(f.services.uploads.status(f.rider.player_id)[0]?.state, 'sending');
  const closing = f.services.uploads.close();
  assert.equal(f.services.uploads.workerStatus, 'stopping');
  assert.equal(f.services.uploads.drain(), first);
  gate.resolve();
  await closing;
  assert.equal(f.services.uploads.workerStatus, 'stopped');
  f.services.uploads.start();
  await f.services.uploads.drain();
  assert.equal(deliveries, 1);
  await f.services.uploads.close();
});

await test('media upload claims serialize requests and deletion during body read cannot recreate a file', async (t) => {
  const f = await mediumFixture(t);

  const activity = create(ActivitySchema, {
    courseId: 6n,
    name: 'Test',
    startDate: '2026-11-14T08:00:00Z',
    playerId: BigInt(f.rider.player_id),
  });

  const id = f.services.recordData.insert('activity', ActivitySchema, activity, ['fit']);
  const media = f.services.activities.insertActivityMedia(f.rider.player_id, id, 'video/mp4').lastInsertRowid;
  const issued = f.services.activities.issueMedia(String(media));
  const gate = Promise.withResolvers<ArrayBuffer>();
  const uploading = f.services.activities.receiveMedia(String(media), issued.token, () => gate.promise);
  await assert.rejects(
    f.services.activities.receiveMedia(String(media), issued.token, () => Promise.resolve(new ArrayBuffer(1))),
    { status: 403 },
  );
  f.services.activities.deleteActivity(BigInt(id), f.rider.player_id);
  gate.resolve(new ArrayBuffer(1));
  await assert.rejects(uploading, { status: 404 });
  assert.equal(existsSync(resolve(f.profiles.folder(f.rider.player_id), 'medias', `${media}.mp4`)), false);
});

await test('failed media body reads release the claim; successful uploads consume it', async (t) => {
  const f = await mediumFixture(t);

  const id = f.services.recordData.insert(
    'activity',
    ActivitySchema,
    create(ActivitySchema, {
      courseId: 6n,
      name: 'Test',
      startDate: '2026-11-14T08:00:00Z',
      playerId: BigInt(f.rider.player_id),
    }),
    ['fit'],
  );

  const media = f.services.activities.insertActivityMedia(f.rider.player_id, id, 'video/mp4').lastInsertRowid;
  const issued = f.services.activities.issueMedia(String(media));
  await assert.rejects(
    f.services.activities.receiveMedia(String(media), issued.token, () => Promise.reject(new Error('read failed'))),
    /read failed/,
  );
  await f.services.activities.receiveMedia(String(media), issued.token, () => Promise.resolve(new ArrayBuffer(2)));
  await assert.rejects(
    f.services.activities.receiveMedia(String(media), issued.token, () => Promise.resolve(new ArrayBuffer(1))),
    { status: 403 },
  );
});

await test('browser continuation requires the same session and current identity version', async (t) => {
  const f = await mediumFixture(t);
  const opened = f.sessions.open();
  const identity = f.accounts.identityOf(f.rider);
  f.sessions.transition(opened.session, { type: 'login', identity });
  f.sessions.transition(opened.session, { type: 'stage-import', stage: 'test' });
  f.sessions.transition(opened.session, { type: 'clear-selection' });
  assert.equal(opened.session.selected, false);
  assert.equal(opened.session.pendingImport, 'test');
  assert.equal(f.sessions.current(opened.id, opened.session, identity), true);
  await f.accounts.changePassword(f.rider.player_id, 'changed');
  assert.equal(f.sessions.current(opened.id, opened.session, identity), false);
  f.sessions.end(opened.id);
  assert.equal(f.sessions.current(opened.id, opened.session, identity), false);
});

await test('Garmin MFA consumes one code and persists compatible tokens only for the current attempt', async (t) => {
  const f = await mediumFixture(t);
  const opened = f.sessions.open();
  f.sessions.transition(opened.session, { type: 'login', identity: f.accounts.identityOf(f.rider) });
  f.services.connections.save(f.rider.player_id, 'garmin', ['test', 'password']);
  t.mock.method(
    GarminClient.prototype,
    'login',
    (): Promise<LoginResult> => Promise.resolve({ state: 'mfa_required', mfaState: mfa }),
  );
  t.mock.method(GarminClient.prototype, 'resumeLogin', function (this: GarminClient) {
    this.setTokens(tokens);

    return Promise.resolve();
  });
  assert.equal(await f.services.integrations.authorizeGarmin(opened.id, opened.session, f.rider), 'mfa');
  assert.equal(await f.services.integrations.authorizeGarmin(opened.id, opened.session, f.rider, '123'), 'authorized');
  const saved = resolve(f.profiles.folder(f.rider.player_id), 'garth/oauth1_token.json');
  assert.deepEqual(JSON.parse(readFileSync(saved, 'utf8')), tokens.oauth1);
  await assert.rejects(f.services.integrations.authorizeGarmin(opened.id, opened.session, f.rider, '123'), /Expired/);
});

await test('an obsolete Garmin login cannot publish tokens or erase the newer MFA attempt', async (t) => {
  const f = await mediumFixture(t);
  const opened = f.sessions.open();
  f.sessions.transition(opened.session, { type: 'login', identity: f.accounts.identityOf(f.rider) });
  f.services.connections.save(f.rider.player_id, 'garmin', ['test', 'password']);
  const gate = Promise.withResolvers<LoginResult>();
  let calls = 0;
  t.mock.method(GarminClient.prototype, 'login', function (this: GarminClient): Promise<LoginResult> {
    this.setTokens(tokens);

    return ++calls === 1 ? gate.promise : Promise.resolve({ state: 'mfa_required', mfaState: mfa });
  });
  const publish = t.mock.method(GarminRepository.prototype, 'saveAuthorization');
  const old = f.services.integrations.authorizeGarmin(opened.id, opened.session, f.rider);
  assert.equal(await f.services.integrations.authorizeGarmin(opened.id, opened.session, f.rider), 'mfa');
  gate.resolve({ state: 'success', ...tokens });
  await assert.rejects(old, /Expired/);
  assert.equal(publish.mock.callCount(), 0);
  t.mock.method(GarminClient.prototype, 'resumeLogin', () => Promise.resolve());
  assert.equal(await f.services.integrations.authorizeGarmin(opened.id, opened.session, f.rider, '123'), 'authorized');
  assert.equal(publish.mock.callCount(), 1);
});

for (const reason of ['expiry', 'logout', 'password', 'disconnect'] as const)
  await test(`Garmin continuation rejects ${reason}`, async (t) => {
    const f = await mediumFixture(t);
    const opened = f.sessions.open();
    f.sessions.transition(opened.session, { type: 'login', identity: f.accounts.identityOf(f.rider) });
    f.services.connections.save(f.rider.player_id, 'garmin', ['test', 'password']);
    t.mock.method(
      GarminClient.prototype,
      'login',
      (): Promise<LoginResult> => Promise.resolve({ state: 'mfa_required', mfaState: mfa }),
    );
    assert.equal(await f.services.integrations.authorizeGarmin(opened.id, opened.session, f.rider), 'mfa');

    switch (reason) {
      case 'expiry': {
        const now = Date.now();
        t.mock.method(Date, 'now', () => now + 300_001);
        break;
      }

      case 'logout': {
        f.sessions.end(opened.id);
        break;
      }

      case 'password': {
        await f.accounts.changePassword(f.rider.player_id, 'changed');
        break;
      }

      case 'disconnect': {
        f.services.connections.remove(f.rider.player_id, 'garmin');
        break;
      }
      // No default
    }

    const resume = t.mock.method(GarminClient.prototype, 'resumeLogin', () => Promise.resolve());
    await assert.rejects(f.services.integrations.authorizeGarmin(opened.id, opened.session, f.rider, '123'), /Expired/);
    assert.equal(resume.mock.callCount(), 0);
  });

await test('Strava authorization cannot publish a token after browser logout', async (t) => {
  const f = await mediumFixture(t);
  const opened = f.sessions.open();
  f.sessions.transition(opened.session, { type: 'login', identity: f.accounts.identityOf(f.rider) });
  f.services.connections.save(f.rider.player_id, 'strava', ['client', 'secret']);
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
  const pending = f.services.integrations.authorizeStrava(opened.id, opened.session, f.rider, 'code');
  f.sessions.end(opened.id);
  gate.resolve();
  await assert.rejects(pending, /Expired/);
  assert.equal(existsSync(resolve(f.profiles.folder(f.rider.player_id), 'strava_token.txt')), false);
});

await test('partially opened runtimes release storage ownership and close is idempotent', async (t) => {
  const f = await mediumFixture(t);

  const fail = t.mock.method(UploadsService.prototype, 'start', () => {
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
  const close = owner.runtime.services.uploads.close.bind(owner.runtime.services.uploads);
  t.mock.method(owner.runtime.services.uploads, 'close', async () => {
    await close();
    throw new Error('close failed');
  });
  await assert.rejects(owner.close(), AggregateError);
  const reopened = await openRuntime(f.config, f.assets);
  await reopened.close();
});
