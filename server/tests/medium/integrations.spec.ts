import { createApp } from '#src/http/app';
import { ActivityUploads } from '#src/repositories/uploads.repository';
import { Connections } from '#src/repositories/connections.repository';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { FeatureRequestSchema, FeatureResponseSchema } from '#src/protocol/generated/variants_pb';
import { runtimeFixture } from '#tests/support/runtime';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { z } from 'zod';

function browser(app: ReturnType<typeof createApp>) {
  let cookie = '';
  let csrf = '';

  const client = {
    get csrf() {
      return csrf;
    },
    async request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set('Cookie', cookie);
      const response = await app.request(path, { ...init, headers });
      const set = response.headers.getSetCookie().at(-1);

      if (set) cookie = set.split(';', 1)[0] ?? '';

      return response;
    },
    async form(path: string, fields: Record<string, string>) {
      return client.request(path, {
        method: 'POST',
        body: new URLSearchParams({ ...fields, csrf_token: csrf }),
      });
    },
    async signIn(player: number, username: string) {
      const response1 = await client.request('/login/');
      const picker = await response1.text();
      csrf = /name="csrf_token"\s+value="([^"]+)"/.exec(picker)?.[1] ?? '';
      await client.form('/login/', { player_id: String(player) });

      // Signing in starts a fresh browser session with its own CSRF token.
      const response2 = await client.request(`/user/${username}/`);
      const home = await response2.text();
      csrf = /name="csrf_token"\s+value="([^"]+)"/.exec(home)?.[1] ?? '';
    },
  };

  return client;
}

await test('Strava credentials are stored encrypted, never echoed, and removal is allow-listed', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Strava Rider', '', true);
  const client = browser(f.app);
  await client.signIn(user.player_id, user.username);

  const saved = await client.form(`/strava/${user.username}/`, {
    client_id: '12345',
    client_secret: 'very-secret-value',
  });

  const body = await saved.text();
  assert.match(body, /Credentials saved/);
  assert.doesNotMatch(body, /very-secret-value/);

  assert.deepEqual(new Connections(f.config.storageDir).read(user.player_id, 'strava'), ['12345', 'very-secret-value']);

  const response3 = await client.form(`/strava/${user.username}/`, {
    client_id: '',
    client_secret: '',
  });

  const empty = await response3.text();

  assert.match(empty, /secret can.+t be empty/);

  await client.form(`/strava/${user.username}/`, { method: 'free' });
  assert.equal(f.settings.read(user.player_id)['uploads.strava.method'], 'free');

  await client.form(`/strava/${user.username}/`, {
    _strava4_session: 'cookie-value',
  });

  const cookieFile = resolve(f.profiles.folder(user.player_id), 'strava4_session.txt');

  assert.equal(readFileSync(cookieFile, 'utf8'), 'cookie-value');
  const response4 = await client.form('/delete/profile.bin', {});
  assert.equal(response4.status, 403);
  const response5 = await client.form('/delete/..%2Fprofile.bin', {});
  assert.equal(response5.status, 403);

  const removed = await client.form('/delete/strava4_session.txt', {});
  assert.equal(removed.status, 302);
  assert.equal(existsSync(cookieFile), false);
  const response6 = await f.app.request('/delete/strava_token.txt');
  assert.equal(response6.status, 404);
});

function activityWithFit() {
  return create(ActivitySchema, {
    id: 99n,
    playerId: 1n,
    name: 'Tempo',
    startDate: '2026-05-01T06:00:00Z',
    fit: Uint8Array.from([1, 2, 3]),
    fitFilename: 'ride.fit',
  });
}

function stubFetch(t: TestContext) {
  const calls: { url: string; method: string; headers: Headers }[] = [];

  t.mock.method(globalThis, 'fetch', (input: URL | string, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
    });

    return Promise.resolve(
      Response.json({
        access_token: 'a',
        refresh_token: 'r',
        expires_at: 9e9,
      }),
    );
  });

  return calls;
}

await test('Intervals.icu upload pairs the planned workout and removes only that workout', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Interval Rider', '', true);
  new Connections(f.config.storageDir).save(user.player_id, 'intervals', ['42', 'key']);
  const folder = f.profiles.folder(user.player_id);
  const cached = resolve(f.config.storageDir, 'tp-workouts/intervalsicu');
  mkdirSync(cached, { recursive: true });
  const first = '7c2b7f55-1f5e-4a3e-8a5e-0f1f4b7a1a11';
  const second = '8d3c8f66-2a6f-4b4f-9b6f-1a2a5c8b2b22';
  writeFileSync(resolve(cached, `${first}.zwo`), '<a/>');
  writeFileSync(resolve(cached, `${second}.zwo`), '<a/>');

  writeFileSync(
    resolve(folder, 'intervals_icu_workout.json'),
    JSON.stringify({
      provider: 'intervals-icu',
      workouts: [
        {
          provider: 'intervals-icu',
          event_id: 5,
          workout_id: first,
          name: 'Tempo',
          start_date_local: '2026-05-01T07:00:00',
          filename: `${first}.zwo`,
        },
        {
          provider: 'intervals-icu',
          event_id: 6,
          workout_id: second,
          name: 'Evening',
          start_date_local: '2026-05-01T18:00:00',
        },
      ],
    }),
  );

  const calls = stubFetch(t);
  const warnings: string[] = [];
  await new ActivityUploads(f, (message) => {
    warnings.push(message);
  }).run(user.player_id, activityWithFit(), []);

  const upload = calls.find((call) => call.url.includes('intervals.icu'));
  assert.ok(upload);
  assert.match(upload.url, /athlete\/42\/activities\?name=Tempo&paired_event_id=5$/);
  assert.equal(upload.headers.get('Authorization'), `Basic ${Buffer.from('API_KEY:key').toString('base64')}`);

  const remaining = z
    .object({ workouts: z.array(z.object({ event_id: z.number() })) })
    .parse(JSON.parse(readFileSync(resolve(folder, 'intervals_icu_workout.json'), 'utf8')));

  assert.deepEqual(
    remaining.workouts.map((item) => item.event_id),
    [6],
  );
  assert.equal(existsSync(resolve(cached, `${first}.zwo`)), false);
  assert.equal(existsSync(resolve(cached, `${second}.zwo`)), true);
  assert.deepEqual(warnings, []);
});

await test('an expired Strava token is refreshed before upload and one failing service does not stop the rest', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Upload Rider', '', true);
  const folder = f.profiles.folder(user.player_id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(resolve(folder, 'strava_token.txt'), '1\nsecret\nold\nrefresh\n1\n');
  writeFileSync(resolve(folder, 'runalyze_token.txt'), 'runalyze-token\n');
  const calls: string[] = [];

  t.mock.method(globalThis, 'fetch', (input: URL | string) => {
    calls.push(String(input));

    if (String(input).includes('/api/v3/uploads')) return Promise.reject(new Error('offline'));

    return Promise.resolve(
      Response.json({
        access_token: 'new',
        refresh_token: 'newer',
        expires_at: 9e9,
      }),
    );
  });

  const warnings: string[] = [];
  await new ActivityUploads(f, (message) => {
    warnings.push(message);
  }).run(user.player_id, activityWithFit(), []);

  assert.equal(readFileSync(resolve(folder, 'strava_token.txt'), 'utf8'), '1\nsecret\nnew\nnewer\n9000000000\n');
  assert.ok(calls.some((url) => url.includes('runalyze.com')));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /^Strava upload failed: offline$/);
});

await test('only administrators can control restarts and bot reloads', async (t) => {
  const f = runtimeFixture(t);
  const admin = await f.accounts.create('Owner', '', true);
  const other = await f.accounts.create('Other', '', false);
  f.world.online.set(77n, create(PlayerStateSchema, { id: 77n }));

  const queued = () => f.world.updates.get(77n)?.length ?? 0;

  for (const [user, expected] of [
    [other, 0],
    [admin, 1],
  ] as const) {
    const client = browser(f.app);
    await client.signIn(user.player_id, user.username);
    const response = await client.form('/restart', {});
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), `/user/${user.username}/`);
    assert.equal(queued(), expected);
    const response7 = await client.form('/reloadbots', {});
    assert.equal(response7.status, 302);
  }

  const client = browser(f.app);
  await client.signIn(admin.player_id, admin.username);
  await client.form('/cancelrestart', {});
  assert.equal(queued(), 2);
});

await test('per-rider variants override the base set and unknown names stay explicit', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Variant Rider', '', true);

  writeFileSync(
    resolve(f.profiles.folder(user.player_id), 'variants.txt'),
    JSON.stringify({ variants: [{ name: 'custom_flag', value: true }] }),
  );

  const client = browser(f.app);
  await client.signIn(user.player_id, user.username);

  const response = await client.request('/experimentation/v1/variant', {
    method: 'POST',
    body: toBinary(
      FeatureRequestSchema,
      create(FeatureRequestSchema, {
        params: [{ param: ['custom_flag', 'missing'] }],
      }),
    ),
  });

  const decoded = fromBinary(FeatureResponseSchema, new Uint8Array(await response.arrayBuffer()));

  assert.deepEqual(
    decoded.variants.map((item) => [item.name, item.value]),
    [
      ['custom_flag', true],
      ['missing', false],
    ],
  );
  const response8 = await f.app.request('/experimentation/v1/variant', { method: 'POST' });
  assert.equal(response8.status, 401);
});

await test('launcher assets are served safely and game assets redirect to the CDN', async (t) => {
  const f = runtimeFixture(t);
  const style = await f.app.request('/style/site.css');
  assert.equal(style.status, 200);
  assert.equal(style.headers.get('Content-Type'), 'text/css');
  assert.match(await style.text(), /background-image: url\('\/style\/background.jpg'\)/);
  const background = await f.app.request('/style/background.jpg');
  assert.equal(background.status, 200);
  assert.equal(background.headers.get('Content-Type'), 'image/jpeg');
  const loading = await f.app.request('/static/web/launcher/embed.html');
  assert.equal(loading.status, 200);
  assert.equal(loading.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.match(await loading.text(), /Loading Zwift/);
  const traversal = await f.app.request('/static/%2e%2e/%2e%2e/tokens.json');
  assert.equal(traversal.status, 404);
  const response9 = await f.app.request('/style/%2e%2e/%2e%2e/README.md');
  assert.equal(response9.status, 404);
  const response10 = await f.app.request('/mochi/watopian/missing.json');
  assert.equal(response10.status, 404);

  const redirect = await f.app.request('/gameassets/Game.xml');
  assert.equal(redirect.status, 302);
  // eslint-disable-next-line unicorn/prefer-https -- The launcher must redirect to the HTTP CDN listener.
  assert.equal(redirect.headers.get('Location'), 'http://cdn.zwift.com/gameassets/Game.xml');
});

await test('the mobile aggregate composes goals, activities, events and invitations', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Mobile Rider', '', true);

  const response = await f.app.request(
    '/relay/worlds/1/aggregate/mobile?goalCount=2&activityCount=2&eventCount=1&eventSport=CYCLING&pendingEventInviteCount=1&acceptedEventInviteCount=1',
    {
      headers: {
        Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}`,
      },
    },
  );

  assert.equal(response.status, 200);

  const body = z
    .object({
      events: z.array(z.json()).max(1),
      goals: z.array(z.json()),
      activities: z.array(z.json()),
      pendingPrivateEventFeed: z.array(z.json()),
      acceptedPrivateEventFeed: z.array(z.json()),
      worldName: z.literal('MAKURIISLANDS'),
      playerCount: z.literal(0),
    })
    .parse(await response.json());

  assert.equal(body.events.length, 1);
  assert.equal(body.goals.length, 0);
});

await test('Strava authorization only completes for the browser that started it', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('OAuth Rider', '', true);
  const client = browser(f.app);
  await client.signIn(user.player_id, user.username);
  new Connections(f.config.storageDir).save(user.player_id, 'strava', ['55', 'secret']);
  const calls = stubFetch(t);

  const start = await client.request('/strava_auth');
  assert.equal(start.status, 302);

  const target = new URL(start.headers.get('Location') ?? '');
  assert.equal(target.searchParams.get('client_id'), '55');
  assert.equal(target.searchParams.get('state'), client.csrf);

  const file = resolve(f.profiles.folder(user.player_id), 'strava_token.txt');
  const refused = await client.request('/authorization?code=abc&state=other');
  assert.match(await refused.text(), /canceled/);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(file), false);

  const accepted = await client.request(`/authorization?code=abc&state=${client.csrf}`);

  assert.match(await accepted.text(), /Strava authorized/);
  assert.equal(readFileSync(file, 'utf8'), '55\nsecret\na\nr\n9000000000\n');
});
