import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { mediumFixture, mediumBrowser } from '#tests/medium/support';
import { PlayerProfileSchema, AchievementsSchema, StreaksSchema } from '#src/protocol/generated/profile_pb';
import { UserStorageSchema } from '#src/protocol/generated/user_storage_pb';
import { LoginResponseSchema } from '#src/protocol/generated/login_pb';
import { Connections } from '#src/node/persistence/connections';
import { writeDurable } from '#src/node/persistence/files';
import { createApp } from '#src/http/app';

const cases = [
  {
    name: 'profile.bin',
    before: toBinary(
      PlayerProfileSchema,
      create(PlayerProfileSchema, { id: 1n, firstName: 'Medium', lastName: 'Rider', totalXp: 123 }),
    ),
    after: toBinary(
      PlayerProfileSchema,
      create(PlayerProfileSchema, { id: 999n, firstName: 'Imported', lastName: 'Source', totalXp: 987 }),
    ),
  },
  {
    name: 'achievements.bin',
    before: toBinary(AchievementsSchema, create(AchievementsSchema, { achievements: [{ id: 43 }] })),
    after: toBinary(AchievementsSchema, create(AchievementsSchema, { achievements: [{ id: 59 }] })),
  },
  {
    name: 'economy_config.txt',
    before: Buffer.from('{"f3":1,"f4":2,"f5":3}'),
    after: Buffer.from('{"f3":4,"f4":5,"f5":6}'),
  },
  {
    name: 'user_storage.bin',
    before: toBinary(
      UserStorageSchema,
      create(UserStorageSchema, { attributes: [{ gameSettings: { minimalLeaderboards: 0 } }] }),
    ),
    after: toBinary(
      UserStorageSchema,
      create(UserStorageSchema, { attributes: [{ gameSettings: { minimalLeaderboards: 1 } }] }),
    ),
  },
  {
    name: 'streaks.bin',
    before: toBinary(StreaksSchema, create(StreaksSchema, { curStreak: 1 })),
    after: toBinary(StreaksSchema, create(StreaksSchema, { curStreak: 3 })),
  },
] as const;

for (const item of cases) {
  await test(`F12 browser restore stages, cancels and confirms ${item.name} with backup and rider isolation`, async (t) => {
    const f = await mediumFixture(t);
    const browser = await mediumBrowser(f);
    const other = await mediumBrowser(f, f.other);
    const folder = f.profiles.folder(f.rider.player_id);
    const path = resolve(folder, item.name);
    writeDurable(path, item.before, true);
    const account = f.accounts.get(f.rider.player_id);

    const upload = async () => {
      const files = new FormData();
      files.set(item.name, new File([Uint8Array.from(item.after)], item.name));
      const response = await browser.upload(`/profile/${f.rider.username}/`, files);
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('Location'), `/profile/${f.rider.username}/confirm/`);
      assert.deepEqual(readFileSync(path), Buffer.from(item.before));
      const review = await browser.request(`/profile/${f.rider.username}/confirm/`);
      assert.equal(review.status, 200);
      assert.match(await review.text(), new RegExp(item.name.replaceAll('.', '\\.')));
    };

    await upload();
    const canceled = await browser.form(`/profile/${f.rider.username}/confirm/`, { cancel: '1' });
    assert.equal(canceled.status, 302);
    assert.deepEqual(readFileSync(path), Buffer.from(item.before));
    assert.equal(
      readdirSync(folder).some((name) => name.startsWith('.ts-import-')),
      false,
    );
    await upload();

    const foreignConfirm = await other.form(`/profile/${f.rider.username}/confirm/`, {
      confirm: '1',
      confirm_source: 'on',
    });

    assert.equal(foreignConfirm.status, 302);
    assert.deepEqual(readFileSync(path), Buffer.from(item.before));

    const published = await browser.form(`/profile/${f.rider.username}/confirm/`, {
      confirm: '1',
      confirm_source: 'on',
    });

    assert.equal(published.status, 302);
    const downloaded = await browser.form('/download', { filename: item.name });
    assert.equal(downloaded.status, 200);
    const bytes = new Uint8Array(await downloaded.arrayBuffer());

    if (item.name === 'profile.bin') {
      const profile = fromBinary(PlayerProfileSchema, bytes);
      assert.equal(profile.id, BigInt(f.rider.player_id));
      assert.equal(profile.firstName, 'Imported');
      assert.equal(profile.totalXp, 987);
      assert.equal(f.accounts.get(f.rider.player_id)?.official_player_id, '999');
    } else assert.deepEqual(bytes, Uint8Array.from(item.after));
    const backups = readdirSync(folder).filter((name) => name.startsWith(`${item.name}.`) && name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    assert.deepEqual(readFileSync(resolve(folder, backups[0]!)), Buffer.from(item.before));
    assert.equal(f.accounts.get(f.rider.player_id)?.auth_version, account?.auth_version);
    assert.equal(f.accounts.get(f.rider.player_id)?.is_admin, account?.is_admin);
    assert.equal(existsSync(resolve(f.profiles.folder(f.other.player_id), item.name)), false);
    assert.equal(
      readdirSync(folder).some((name) => name.startsWith('.ts-import-')),
      false,
    );
  });
}

await test('F12 multipart restore accepts selected empty protobuf files and requires CSRF before staging', async (t) => {
  const f = await mediumFixture(t);
  const browser = await mediumBrowser(f);
  const names = ['achievements.bin', 'user_storage.bin', 'streaks.bin'];
  const missingCsrf = new FormData();
  missingCsrf.set('streaks.bin', new File([], 'streaks.bin'));
  const rejected = await browser.request(`/profile/${f.rider.username}/`, { method: 'POST', body: missingCsrf });
  assert.equal(rejected.status, 400);
  const files = new FormData();

  for (const name of names) files.set(name, new File([], name));
  const staged = await browser.upload(`/profile/${f.rider.username}/`, files);
  assert.equal(staged.status, 302);
  const unconfirmed = await browser.form(`/profile/${f.rider.username}/confirm/`, { confirm: '1' });
  assert.equal(unconfirmed.status, 400);
  const published = await browser.form(`/profile/${f.rider.username}/confirm/`, { confirm: '1', confirm_source: 'on' });
  assert.equal(published.status, 302);

  for (const name of names) {
    const response = await browser.form('/download', { filename: name });
    assert.equal(response.status, 200);
    const bytes = await response.arrayBuffer();
    assert.equal(bytes.byteLength, 0);
  }
});

await test('F12 app reconstruction rolls back a partially published restore before serving rider state', async (t) => {
  const f = await mediumFixture(t);
  const browser = await mediumBrowser(f);
  const folder = f.profiles.folder(f.rider.player_id);
  const original = toBinary(StreaksSchema, create(StreaksSchema, { curStreak: 2 }));
  const incoming = toBinary(StreaksSchema, create(StreaksSchema, { curStreak: 99 }));
  writeDurable(resolve(folder, 'streaks.bin'), original);
  const files = new FormData();
  files.set('streaks.bin', new File([incoming], 'streaks.bin'));
  const staged = await browser.upload(`/profile/${f.rider.username}/`, files);
  assert.equal(staged.status, 302);
  const stage = readdirSync(folder).find((name) => name.startsWith('.ts-import-'));
  assert.ok(stage);
  const manifestPath = resolve(folder, stage, 'manifest.json');
  const manifest = z.record(z.string(), z.json()).parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  // Simulate a process stopping between file replacement and journal commit.
  writeDurable(resolve(folder, stage, 'old-streaks.bin'), original);
  writeDurable(resolve(folder, 'streaks.bin'), incoming, true);
  writeDurable(manifestPath, JSON.stringify({ ...manifest, state: 'publishing' }), true);
  const restarted = createApp({ gameInfo: '{}', gameInfoHash: '0', variants: '{}' }, f);
  const response = await restarted.request('/api/fitness/streaks', { headers: f.headers() });
  assert.equal(response.status, 200);
  assert.equal(fromBinary(StreaksSchema, new Uint8Array(await response.arrayBuffer())).curStreak, 2);
  assert.deepEqual(readFileSync(resolve(folder, 'streaks.bin')), Buffer.from(original));
  assert.equal(existsSync(resolve(folder, stage)), false);
});

for (const choice of ['profile', 'achievements', 'both']) {
  await test(`F12 official ${choice} download uses saved encrypted credentials and requires browser confirmation`, async (t) => {
    const f = await mediumFixture(t);
    const browser = await mediumBrowser(f);
    const connection = `/zwift/${f.rider.username}/`;

    const saved = await browser.form(connection, {
      action: 'settings',
      username: 'official@example.test',
      password: 'medium-secret',
      upload: 'on',
      click: 'on',
    });

    assert.equal(saved.status, 200);
    assert.doesNotMatch(await saved.text(), /medium-secret|official@example.test/);
    const connections = new Connections(f.config.storageDir);
    assert.deepEqual(connections.read(f.rider.player_id, 'zwift'), ['official@example.test', 'medium-secret']);
    assert.equal(
      readFileSync(connections.file(f.rider.player_id, 'zwift')).includes(Buffer.from('medium-secret')),
      false,
    );
    assert.equal(connections.read(f.other.player_id, 'zwift'), null);
    assert.equal(f.settings.read(f.rider.player_id)['uploads.zwift.enabled'], true);
    assert.equal(f.settings.read(f.rider.player_id)['devices.zwiftClick.enabled'], true);
    const calls: string[] = [];
    t.mock.method(globalThis, 'fetch', async (input: URL | string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      await Promise.resolve();

      if (path.endsWith('/access/codes')) {
        assert.ok(init?.body instanceof URLSearchParams);
        assert.equal(init.body.get('username'), 'official@example.test');
        assert.equal(init.body.get('password'), 'medium-secret');

        return Response.json({ access_token: 'official-token', refresh_token: 'official-refresh' });
      }

      if (path.endsWith('/tokens/logout')) return new Response(null, { status: 204 });
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer official-token');
      assert.equal(new Headers(init?.headers).get('Accept'), 'application/x-protobuf-lite');

      if (path === '/api/profiles/me')
        return new Response(
          toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 999n, firstName: 'Official', totalXp: 500 })),
        );

      if (path === '/api/users/login')
        return new Response(
          toBinary(
            LoginResponseSchema,
            create(LoginResponseSchema, {
              sessionState: 'test',
              info: { relayUrl: 'https://relay.test' },
              economyConfig: { f3: 0, f4: 0, f5: 0 },
            }),
          ),
        );

      if (path === '/api/achievement/loadPlayerAchievements')
        return new Response(toBinary(AchievementsSchema, create(AchievementsSchema, { achievements: [{ id: 59 }] })));
      throw new Error(`Unexpected official request ${path}`);
    });

    const selection = {
      action: 'import',
      profile: choice === 'achievements' ? '' : 'on',
      achievements: choice === 'profile' ? '' : 'on',
    };

    const downloaded = await browser.form(connection, selection);
    assert.equal(downloaded.status, 302);
    assert.equal(f.profiles.get(f.rider.player_id).firstName, 'Medium');
    assert.equal(f.accounts.get(f.rider.player_id)?.official_player_id, null);

    const published = await browser.form(`/profile/${f.rider.username}/confirm/`, {
      confirm: '1',
      confirm_source: 'on',
      keep_name: 'on',
    });

    assert.equal(published.status, 302);
    assert.equal(f.profiles.get(f.rider.player_id).id, BigInt(f.rider.player_id));
    assert.equal(f.profiles.get(f.rider.player_id).firstName, 'Medium');
    const folder = f.profiles.folder(f.rider.player_id);
    assert.equal(existsSync(resolve(folder, 'economy_config.txt')), choice !== 'achievements');
    assert.equal(existsSync(resolve(folder, 'achievements.bin')), choice !== 'profile');
    assert.equal(calls.includes('/api/profiles/me'), choice !== 'achievements');
    assert.equal(calls.includes('/api/achievement/loadPlayerAchievements'), choice !== 'profile');
    assert.equal(calls.at(-1), '/auth/realms/zwift/tokens/logout');

    if (choice !== 'achievements') {
      assert.equal(f.profiles.get(f.rider.player_id).totalXp, 500);
      assert.equal(f.accounts.get(f.rider.player_id)?.official_player_id, '999');
    }

    const disabled = await browser.form(connection, { action: 'settings', click: 'on' });
    assert.equal(disabled.status, 200);
    assert.equal(f.settings.read(f.rider.player_id)['uploads.zwift.enabled'], false);
    assert.equal(f.settings.read(f.rider.player_id)['devices.zwiftClick.enabled'], true);
    assert.deepEqual(new Connections(f.config.storageDir).read(f.rider.player_id, 'zwift'), [
      'official@example.test',
      'medium-secret',
    ]);

    const invalidCsrf = await browser.request(connection, {
      method: 'POST',
      body: new URLSearchParams({ action: 'settings', password: 'rejected' }),
    });

    assert.equal(invalidCsrf.status, 400);
    const removed = await browser.form('/delete/zwift_credentials.bin');
    assert.equal(removed.status, 302);
    assert.equal(new Connections(f.config.storageDir).read(f.rider.player_id, 'zwift'), null);
  });
}

for (const failure of ['login', 'profile', 'invalid profile']) {
  await test(`F12 failed official import preserves rider data and creates no pending stage: ${failure}`, async (t) => {
    const f = await mediumFixture(t);
    const browser = await mediumBrowser(f);
    const connection = `/zwift/${f.rider.username}/`;
    await browser.form(connection, {
      action: 'settings',
      username: 'official@example.test',
      password: 'medium-secret',
    });
    const profilePath = resolve(f.profiles.folder(f.rider.player_id), 'profile.bin');
    const before = toBinary(PlayerProfileSchema, f.profiles.get(f.rider.player_id));
    writeDurable(profilePath, before);
    let loggedOut = false;
    const calls: string[] = [];
    t.mock.method(globalThis, 'fetch', (input: URL | string) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);

      if (path.endsWith('/tokens/logout')) {
        loggedOut = true;

        return Promise.resolve(new Response(null, { status: 204 }));
      }

      if (path.endsWith('/access/codes'))
        return Promise.resolve(
          failure === 'login'
            ? new Response(null, { status: 401 })
            : Response.json({ access_token: 'official-token', refresh_token: 'refresh' }),
        );

      if (path === '/api/profiles/me')
        return Promise.resolve(
          failure === 'profile' ? new Response(null, { status: 503 }) : new Response(new Uint8Array([255])),
        );

      if (path === '/api/users/login')
        return Promise.resolve(
          new Response(
            toBinary(
              LoginResponseSchema,
              create(LoginResponseSchema, { sessionState: 'test', info: { relayUrl: 'https://relay.test' } }),
            ),
          ),
        );
      throw new Error(`Unexpected official request ${path}`);
    });
    const response = await browser.form(connection, { action: 'import', profile: 'on' });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Download failed/);
    assert.doesNotMatch(html, /medium-secret|official-token/);
    assert.deepEqual(readFileSync(profilePath), Buffer.from(before));
    assert.equal(
      readdirSync(f.profiles.folder(f.rider.player_id)).some((name) => name.startsWith('.ts-import-')),
      false,
    );
    assert.equal(loggedOut, failure !== 'login');
    assert.deepEqual(calls, [
      '/auth/realms/zwift/tokens/access/codes',
      ...(failure === 'login'
        ? []
        : [
            '/api/profiles/me',
            ...(failure === 'invalid profile' ? ['/api/users/login'] : []),
            '/auth/realms/zwift/tokens/logout',
          ]),
    ]);
    const confirm = await browser.request(`/profile/${f.rider.username}/confirm/`);
    assert.equal(confirm.status, 302);
    assert.equal(confirm.headers.get('Location'), `/profile/${f.rider.username}/`);
  });
}
