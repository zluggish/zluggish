import { ManagementService } from '#src/services/management.service';
import { UploadsService } from '#src/services/uploads.service';
import { WorkoutsService } from '#src/services/workout.service';
import { Effect, Schema } from 'effect';
import { IntegrationsService } from '#src/services/integrations.service';
import { ConnectionsService } from '#src/services/connections.service';
import { runtimeFixture } from '#tests/support/runtime';
import { createWebApp } from '#src/http/web-app';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { create, toBinary } from '@bufbuild/protobuf';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import type { User } from '#src/repositories/accounts.repository';

async function browserFixture(t: TestContext) {
  const network = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected external provider call in browser test');
  });

  t.after(() => assert.equal(network.mock.callCount(), 0));
  const f = runtimeFixture(t);
  const server = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 });
  t.after(() => server.close());

  if (!server.listening) {
    await once(server, 'listening');
  }
  const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }))(server.address());
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  t.after(() => browser.close());

  const web = serve({ fetch: createWebApp(f).fetch, hostname: '127.0.0.1', port: 0 });
  t.after(() => web.close());

  if (!web.listening) {
    await once(web, 'listening');
  }
  const webAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }))(web.address());

  return { ...f, origin, browser, webOrigin: `http://127.0.0.1:${webAddress.port}` };
}

/** Signs in to the web app as an administrator created by first-time setup. */
async function webSignIn(page: Page, f: Awaited<ReturnType<typeof browserFixture>>, rider: User) {
  await f.effects.runPromise(
    ManagementService.use((management) =>
      management.setup({
        mode: 'existing',
        key: f.effects.runSync(ManagementService.use((management) => management.issueSetupKey()))!,
        player_id: rider.player_id,
        password: 'test-password',
      }),
    ),
  );
  await page.goto(`${f.webOrigin}/sign-in`);
  await page.getByLabel('Login name', { exact: true }).fill(rider.username);
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Activities', exact: true }).waitFor();
}

async function signIn(page: Page, origin: string, id: number, password = 'test-password', remember = false) {
  await page.goto(`${origin}/login/`);
  await page.locator(`form:has(input[name=player_id][value="${id}"]) button`).click();
  await page.getByLabel('Password', { exact: true }).fill(password);

  if (remember) {
    await page.getByLabel('Remember password', { exact: true }).check();
  }
  // A sign-in password is not a setting, so the form must not report unsaved changes.
  assert.equal(await page.getByText('Unsaved changes').count(), 0);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/user/**');
}

await test('web app resumes startup after the server reconnects', async (t) => {
  const f = await browserFixture(t);
  const page = await f.browser.newPage();
  await page.route('**/health', (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.route('**/api/setup', (route) => route.abort());
  await page.goto(`${f.webOrigin}/sign-in`);
  await page.getByText(/^Server connection lost\.\.\.retrying in \d+s$/).waitFor();
  assert.equal(
    await page.getByText('Unable to connect to the server. Please try again once the connection is restored.').count(),
    0,
  );
  await page.unroute('**/api/setup');
  await page.unroute('**/health');
  await page.getByRole('button', { name: 'Retry now' }).click();
  await page.getByText('Server connection lost', { exact: false }).waitFor({ state: 'hidden' });
  await page.getByText('Loading...', { exact: true }).waitFor({ state: 'hidden' });
  await page.locator('form').first().waitFor();
});

await test('refreshing a signed-in page does not show the sign-in heading while loading', async (t) => {
  const f = await browserFixture(t);
  const page = await f.browser.newPage();
  page.setDefaultTimeout(7000);
  const rider = await f.accounts.create('Refresh Rider', 'test-password', 'refresh');
  await webSignIn(page, f, rider);
  await page.goto(`${f.webOrigin}/manage/companion`);
  await page.getByRole('heading', { name: 'Companion for Android', exact: true }).waitFor();

  const { promise: paused, resolve: release } = Promise.withResolvers<void>();
  const { promise: requested, resolve: started } = Promise.withResolvers<void>();
  await page.route('**/api/setup', async (route) => {
    started();
    await paused;
    await route.continue();
  });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await requested;
    assert.equal(await page.locator('.bar').isVisible(), false);
    assert.equal(await page.locator('p[role="status"]').count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Sign in', exact: true }).count(), 0);
    await page.getByText("Loading… Please wait, or reload the page if it doesn't respond.").waitFor();
    assert.equal(await page.getByRole('button', { name: 'Reload this page' }).isVisible(), true);
  } finally {
    release();
  }
  await page.getByRole('heading', { name: 'Companion for Android', exact: true }).waitFor();
});

await test('companion page stays quiet briefly and offers help if its status is slow', async (t) => {
  const f = await browserFixture(t);
  const page = await f.browser.newPage();
  page.setDefaultTimeout(7000);
  const rider = await f.accounts.create('Companion Rider', 'test-password', 'companion');
  await webSignIn(page, f, rider);
  const { promise: paused, resolve: release } = Promise.withResolvers<void>();
  const { promise: requested, resolve: started } = Promise.withResolvers<void>();
  await page.route('**/api/manage/companion', async (route) => {
    started();
    await paused;
    await route.continue();
  });
  try {
    await page.goto(`${f.webOrigin}/manage/companion`, { waitUntil: 'domcontentloaded' });
    await requested;
    assert.equal(await page.getByText('Loading…', { exact: true }).isVisible(), false);
    await page.getByText("Loading… Please wait, or reload the page if it doesn't respond.").waitFor();
    assert.equal(await page.getByRole('button', { name: 'Reload this page' }).isVisible(), true);
  } finally {
    release();
  }
  await page.getByRole('heading', { name: 'Companion for Android' }).waitFor();
});

await test('android management stays quiet during a short load and explains a slow one', async (t) => {
  const f = await browserFixture(t);
  const page = await f.browser.newPage();
  page.setDefaultTimeout(7000);
  const rider = await f.accounts.create('Android Rider', 'test-password', 'android');
  await webSignIn(page, f, rider);
  const { promise: paused, resolve: release } = Promise.withResolvers<void>();
  const { promise: requested, resolve: started } = Promise.withResolvers<void>();
  await page.route('**/api/install/android', async (route) => {
    started();
    await paused;
    await route.continue();
  });
  try {
    await page.goto(`${f.webOrigin}/manage/android`, { waitUntil: 'domcontentloaded' });
    await requested;
    assert.equal(await page.getByText('Loading…', { exact: true }).isVisible(), false);
    await page.getByText("Loading… Please wait, or reload the page if it doesn't respond.").waitFor();
    assert.equal(await page.getByRole('button', { name: 'Reload this page' }).isVisible(), true);
  } finally {
    release();
  }
  await page
    .getByRole('link', { name: /Zwift for Android/ })
    .first()
    .waitFor();
});

for (const javaScriptEnabled of [true, false]) {
  await test(`web-created rider, protected login and native POST with JavaScript ${javaScriptEnabled}`, async (t) => {
    const f = await browserFixture(t);

    const context = await f.browser.newContext({
      javaScriptEnabled,
      viewport: { width: 420, height: 600 },
      reducedMotion: 'reduce',
    });

    const page = await context.newPage();
    const errors: Array<string> = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });
    await f.effects.runPromise(
      ManagementService.use((management) =>
        management.setup({
          mode: 'new',
          key: f.effects.runSync(ManagementService.use((management) => management.issueSetupKey()))!,
          username: 'browser',
          first_name: 'New Browser',
          last_name: 'Rider',
          password: 'browser-password',
        }),
      ),
    );
    await page.goto(`${f.origin}/login/`);
    const rider = f.accounts.list()[0]!;
    await page.getByRole('button', { name: 'New Browser Rider' }).click();
    await page.getByLabel('Password', { exact: true }).fill('wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByText('Wrong password. Try again.', { exact: true }).first().waitFor();
    await signIn(page, f.origin, rider.player_id, 'browser-password', true);

    // Switching ends the session and returns to the user list; the remembered user needs no password.
    await page.getByRole('button', { name: 'Switch rider' }).click();
    await page.waitForURL('**/login/');
    await page.getByRole('button', { name: 'New Browser Rider' }).click();
    await page.waitForURL('**/user/**');
    // Inspect the native request while preventing the browser's external protocol handler.
    let posted = '';
    await page.route('**/start-zwift', async (route) => {
      posted = route.request().postData() ?? '';
      const response = await route.fetch({ maxRedirects: 0 });
      assert.equal(response.status(), 302);
      assert.equal(response.headers().location, '/ride');
      await route.fulfill({ status: 200, contentType: 'text/html', body: 'Launch POST accepted' });
    });
    await page.getByRole('button', { name: 'Start Zwift', exact: true }).click();
    await page.getByText('Launch POST accepted').waitFor();
    assert.match(posted, /csrf_token=/);
    assert.match(posted, /map=CALENDAR/);
    const handoff = await context.request.get(`${f.origin}/ride`, { maxRedirects: 0 });
    assert.equal(handoff.status(), 302);
    assert.match(handoff.headers().location!, /^http:\/\/zwift\/\?code=zwift_refresh_token/);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

await test('a session change locks the dashboard instead of acting as another user', async (t) => {
  const f = await browserFixture(t);
  const rider = await f.accounts.create('Locked Rider', 'test-password');
  const context = await f.browser.newContext();
  const page = await context.newPage();
  await signIn(page, f.origin, rider.player_id);
  f.sessions.browsers.clear();
  await page.getByRole('button', { name: 'Switch rider' }).click();
  await page.getByRole('button', { name: 'Reload this page' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Start Zwift' }).isDisabled(), true);
  await context.close();
});

await test('the launcher switches users without JavaScript', async (t) => {
  const f = await browserFixture(t);
  const rider = await f.accounts.create('Plain Rider', 'test-password');
  t.mock.method(f.effects.runSync(WorkoutsService), 'syncWorkoutsAutomatically', () => Effect.void);
  const context = await f.browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await signIn(page, f.origin, rider.player_id);
  assert.equal(
    await page
      .getByRole('link')
      .filter({ hasText: /settings/i })
      .count(),
    0,
  );
  await Promise.all([page.waitForURL('**/login/'), page.getByRole('button', { name: 'Switch rider' }).click()]);
  await page.getByRole('button', { name: 'Plain Rider' }).waitFor();
  await context.close();
});

await test('import review requires source confirmation and cancel bypasses validation', async (t) => {
  const f = await browserFixture(t);
  const rider = await f.accounts.create('Import Rider', 'test-password');
  f.accounts.repository.updateImportedProfile(rider.player_id, 'Import', 'Rider', 123);
  await f.effects.runPromise(
    ManagementService.use((management) =>
      management.setup({
        mode: 'existing',
        key: f.effects.runSync(ManagementService.use((management) => management.issueSetupKey()))!,
        player_id: rider.player_id,
        password: 'test-password',
      }),
    ),
  );
  const context = await f.browser.newContext();
  const page = await context.newPage();
  await page.goto(`${f.webOrigin}/sign-in`);
  await page.getByLabel('Login name', { exact: true }).fill(rider.username);
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Activities', exact: true }).waitFor();

  const buffer = Buffer.from(
    toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 999n, firstName: 'Remote', lastName: 'Source' })),
  );

  for (const cancel of [true, false]) {
    await page.goto(`${f.webOrigin}/profile-data/local`);
    await page
      .locator('[name="profile.bin"]')
      .setInputFiles({ name: 'profile.bin', mimeType: 'application/octet-stream', buffer });
    await page.getByRole('button', { name: 'Review import' }).click();
    await page.getByRole('heading', { name: 'Confirm profile import' }).waitFor();

    if (cancel) {
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    } else {
      await page.getByLabel('Confirm this source may differ or be shared with another user').check();
      await page.getByRole('button', { name: 'Confirm import', exact: true }).click();
    }

    await page
      .getByText(cancel ? 'Import canceled. Your user data is unchanged.' : 'Profile data imported.', { exact: true })
      .waitFor();
    assert.equal(f.accounts.get(rider.player_id)?.first_name, cancel ? 'Import' : 'Remote');
  }

  await context.close();
});

await test('web connections keep saved secrets, show Garmin MFA and run workout sync and session tests', async (t) => {
  const f = await browserFixture(t);
  const rider = await f.accounts.create('Connected Rider', 'test-password');
  const integrations = f.effects.runSync(IntegrationsService);
  t.mock.method(integrations, 'authorizeGarminSession', () => Effect.succeed('mfa' as const));
  t.mock.method(integrations, 'checkSession', () => Effect.succeed(true));
  t.mock.method(f.effects.runSync(WorkoutsService), 'sync', () => Effect.succeed('Synced 2 Intervals.icu workouts.'));
  const context = await f.browser.newContext();
  const page = await context.newPage();
  await webSignIn(page, f, rider);
  await page.goto(`${f.webOrigin}/integrations`);
  await page.getByRole('button', { name: /^Strava/ }).click();
  const strava = page.locator('form').filter({ has: page.getByLabel('Client ID') });
  await strava.getByLabel('Client ID').fill('123');
  await strava.getByLabel('Client secret').fill('private-client-secret');
  await strava.getByRole('button', { name: 'Save credentials' }).click();
  await page.getByText('Credentials saved.', { exact: true }).waitFor();
  assert.equal(await strava.getByLabel('Client secret').inputValue(), '');
  await strava.getByLabel('Client ID').fill('456');
  await strava.getByRole('button', { name: 'Save credentials' }).click();
  await page.getByText('Credentials saved.', { exact: true }).waitFor();
  assert.deepEqual(f.effects.runSync(ConnectionsService.use((service) => service.read(rider.player_id, 'strava'))), [
    '456',
    'private-client-secret',
  ]);

  await page.getByLabel('Upload method').selectOption('free');
  await page.getByText('Upload method saved.', { exact: true }).waitFor();
  await page.getByLabel('_strava4_session').fill('session-cookie');
  await page.getByRole('button', { name: 'Save session cookie' }).click();
  await page.getByText('Session cookie saved.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Test session' }).click();
  await page.getByText('Strava session verified', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });

  await page.getByRole('button', { name: /^Garmin/ }).click();
  const garmin = page.locator('form').filter({ has: page.getByLabel('Email') });
  await garmin.getByLabel('Email').fill('garmin-user');
  await garmin.getByLabel('Password').fill('garmin-secret');
  await garmin.getByRole('button', { name: 'Save credentials' }).click();
  await page.getByText('Credentials saved.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Authorize', exact: true }).click();
  await page.getByLabel('Verification code').waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });

  await page.getByRole('button', { name: /^Intervals\.icu/ }).click();
  const intervals = page.locator('form').filter({ has: page.getByLabel('Athlete ID') });
  await intervals.getByLabel('Athlete ID').fill('42');
  await intervals.getByLabel('API key').fill('intervals-secret');
  await intervals.getByRole('button', { name: 'Save credentials' }).click();
  await page.getByText('Credentials saved.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Sync workouts' }).click();
  await page.getByText('Synced 2 Intervals.icu workouts.', { exact: true }).waitFor();

  const intervalsUpload = page.getByLabel('Upload completed activities', { exact: true });
  await intervalsUpload.waitFor();
  assert.equal(await intervalsUpload.isChecked(), true);
  await intervalsUpload.uncheck();
  await page.getByText('Upload setting saved.', { exact: true }).waitFor();
  assert.equal(f.settings.read(rider.player_id)['uploads.intervals.enabled'], false);

  await context.close();
});

await test('web upload list polls while uploads run, pauses while hidden and retries failures', async (t) => {
  const f = await browserFixture(t);
  const rider = await f.accounts.create('Uploading Rider', 'test-password');
  let state = 'pending';

  const status = t.mock.method(f.effects.runSync(UploadsService), 'status', () =>
    Effect.succeed([{ activity_id: 1, provider: 'strava', state, last_error: null }]),
  );

  const retry = t.mock.method(f.effects.runSync(UploadsService), 'retry', () => Effect.void);
  const context = await f.browser.newContext();
  const page = await context.newPage();
  await page.clock.install();
  await webSignIn(page, f, rider);
  await page.goto(`${f.webOrigin}/integrations`);
  await page.getByText('Activity 1: strava — pending', { exact: true }).waitFor();
  const initial = status.mock.callCount();
  await page.evaluate(() => {
    // Browser callback runs in the page's DOM environment.
    const { document } = globalThis;
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(15_000);
  assert.equal(status.mock.callCount(), initial);
  state = 'failed';
  await page.evaluate(() => {
    // Browser callback runs in the page's DOM environment.
    const { document } = globalThis;
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(5100);
  await page.getByText('Activity 1: strava — failed', { exact: true }).waitFor();
  const stopped = status.mock.callCount();
  await page.clock.runFor(15_000);
  assert.equal(status.mock.callCount(), stopped);
  await page.getByRole('button', { name: 'Retry failed uploads' }).click();
  await page.getByText('Retry requested. Check the provider before retrying again.', { exact: true }).waitFor();
  assert.deepEqual(retry.mock.calls[0]?.arguments, [rider.player_id, false]);
  await context.close();
});

for (const app of ['webapp', 'launcher']) {
  await test(`${app} reports outages and recovers without losing input`, async (t) => {
    const f = await browserFixture(t);
    const page = await f.browser.newPage();
    page.setDefaultTimeout(7000);
    const rider = await f.accounts.create('Outage Rider', 'test-password', 'outage');

    if (app === 'webapp') {
      await webSignIn(page, f, rider);
    } else {
      await page.goto(`${f.origin}/login/`);
      await page.locator(`form:has(input[name=player_id][value="${rider.player_id}"]) button`).click();
    }

    if (app === 'webapp') {
      await page.goto(`${f.webOrigin}/profile`);
    }
    const field = page.getByLabel(app === 'webapp' ? 'First name' : 'Password', { exact: true });
    await field.fill(app === 'webapp' ? 'Unsaved' : 'draft-password');
    await page.route('**/health', (route) =>
      route.fulfill({ status: 503, contentType: 'text/html', body: '<!DOCTYPE html>Unavailable' }),
    );

    if (app === 'webapp') {
      await page.route('**/api/me/profile', (route) =>
        route.fulfill({ status: 502, contentType: 'text/html', body: '<!DOCTYPE html>Bad gateway' }),
      );
      await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    } else {
      await page.route('**/login/', (route) =>
        route.fulfill({ status: 502, contentType: 'text/html', body: '<!DOCTYPE html>Bad gateway' }),
      );
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    }

    await page.getByText(/^Server connection lost\.\.\.retrying in \d+s$/).waitFor();
    assert.equal(await field.inputValue(), app === 'webapp' ? 'Unsaved' : 'draft-password');
    assert.equal(await page.getByText(/Unexpected token/).count(), 0);
    await page.unroute('**/health');
    await page.getByRole('button', { name: 'Retry now' }).click();
    await page.getByRole('button', { name: 'Retry now' }).waitFor({ state: 'hidden' });
    assert.equal(await page.getByText('Connection restored.', { exact: true }).count(), 0);
    assert.equal(await field.inputValue(), app === 'webapp' ? 'Unsaved' : 'draft-password');
  });
}
