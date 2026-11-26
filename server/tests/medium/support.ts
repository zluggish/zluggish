import { WebSessionsService } from '#src/services/web-session.service';
import { inputValue } from '#tests/support/html';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { DescMessage } from '@bufbuild/protobuf';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { runtimeFixture } from '#tests/support/runtime';
import { createWebApp } from '#src/http/web-app';
import type { User } from '#src/repositories/accounts.repository';
import type { JsonValue } from '#src/dtos/management.dto';
import { activityFolder } from '#src/activity-storage';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export async function mediumFixture(t: TestContext, publicUrl: string | null = null, webEnabled = true) {
  const network = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected external request in medium test');
  });

  t.after(() => assert.equal(network.mock.callCount(), 0, 'External providers must be explicitly mocked'));
  const f = runtimeFixture(t, publicUrl, webEnabled);
  // Runtime lifecycle tests must not schedule real release checks against external providers.
  const empty = { apkmirror: null, apkpure: null, errors: { apkmirror: null, apkpure: null } };
  writeFileSync(
    resolve(f.config.storageDir, 'app-releases.json'),
    JSON.stringify({
      enabled: false,
      checkedAt: null,
      apps: { zwift: empty, companion: empty },
    }),
  );
  const rider = await f.accounts.create('Medium Rider', 'test-password');
  const other = await f.accounts.create('Other Rider', 'test-password');
  const headers = (user = rider) => ({ Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}` });

  const request = (path: string, init: RequestInit = {}, user = rider) => {
    const requestHeaders = new Headers(headers(user));

    for (const [name, value] of new Headers(init.headers)) {
      requestHeaders.set(name, value);
    }

    return f.app.request(path, { ...init, headers: requestHeaders });
  };

  return { ...f, rider, other, headers, request };
}

export function binary<S extends DescMessage>(schema: S, value: Parameters<typeof create<S>>[1]) {
  return { headers: { 'Content-Type': 'application/x-protobuf-lite' }, body: toBinary(schema, create(schema, value)) };
}

export async function decode<S extends DescMessage>(response: Response, schema: S, status = 200) {
  assert.equal(response.status, status);

  return fromBinary(schema, new Uint8Array(await response.arrayBuffer()));
}

export async function mediumBrowser(f: Awaited<ReturnType<typeof mediumFixture>>, rider = f.rider) {
  let cookie = '';
  let csrf = '';

  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Cookie', cookie);
    const response = await f.app.request(path, { ...init, headers });
    cookie = response.headers.getSetCookie().at(-1)?.split(';', 1)[0] ?? cookie;
    const body = await response.clone().text();
    csrf = inputValue(body, 'csrf_token') ?? csrf;

    return response;
  };

  const form = (path: string, fields: Record<string, string> = {}) =>
    request(path, {
      method: 'POST',
      body: new URLSearchParams({
        csrf_token: csrf,
        revision: String(f.settings.revision(rider.player_id)),
        ...fields,
      }),
    });

  const upload = (path: string, files: FormData) => {
    files.set('csrf_token', csrf);

    return request(path, { method: 'POST', body: files });
  };

  const picker = await request('/login/');
  assert.equal(picker.status, 200);

  const selected = await form('/login/', {
    player_id: String(rider.player_id),
    step: 'password',
    password: 'test-password',
  });

  assert.equal(selected.status, 302);
  const dashboard = await request(selected.headers.get('Location')!);
  assert.equal(dashboard.status, 200);

  return { request, form, upload };
}

/** A signed-in web app session for the rider: JSON or multipart requests with its CSRF token. */
export function mediumWeb(f: ReturnType<typeof runtimeFixture>, rider: User) {
  const app = createWebApp(f);

  const { id, session } = f.effects.runSync(
    WebSessionsService.use((sessions) => sessions.create(f.accounts.identityOf(rider))),
  );

  const request = (
    path: string,
    method = 'GET',
    data?: FormData | Uint8Array<ArrayBuffer> | Record<string, JsonValue>,
    csrf = session.csrf,
  ) => {
    const headers = new Headers({
      Cookie: `zluggish_web_session=${id}`,
      Origin: 'http://local:8080',
      'X-CSRF-Token': csrf,
    });

    // Fetch sets the multipart boundary itself; raw bytes go up as a file.
    if (data instanceof Uint8Array) {
      headers.set('Content-Type', 'application/octet-stream');
    } else if (!(data instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }

    return app.request(`http://local:8080${path}`, {
      method,
      headers,
      ...(data && {
        body: data instanceof FormData || data instanceof Uint8Array ? data : JSON.stringify(data),
      }),
    });
  };

  return { app, request };
}

/** The folder of an activity in the new layout; assigns its name like the server does. */
export function activityFolderOf(
  f: Pick<ReturnType<typeof runtimeFixture>, 'accounts' | 'profiles'>,
  activity: number | bigint,
) {
  const stored = f.accounts.repositories.activitiesRepository.storageDirectory(activity);
  assert.ok(stored, `activity ${activity} exists`);

  return activityFolder(f.profiles.folder(stored.player), stored.directory);
}
