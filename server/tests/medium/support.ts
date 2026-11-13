import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { DescMessage } from '@bufbuild/protobuf';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { runtimeFixture } from '#tests/support/runtime';

export async function mediumFixture(t: TestContext) {
  const network = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected external request in medium test');
  });

  t.after(() => assert.equal(network.mock.callCount(), 0, 'External providers must be explicitly mocked'));
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Medium Rider', '', true);
  const other = await f.accounts.create('Other Rider', '');
  const headers = (user = rider) => ({ Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}` });

  const request = (path: string, init: RequestInit = {}, user = rider) =>
    f.app.request(path, { ...init, headers: { ...headers(user), ...init.headers } });

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
    csrf = /name="csrf_token"\s+value="([^"]+)"/.exec(body)?.[1] ?? csrf;

    return response;
  };

  const form = (path: string, fields: Record<string, string> = {}) =>
    request(path, { method: 'POST', body: new URLSearchParams({ csrf_token: csrf, ...fields }) });

  const upload = (path: string, files: FormData) => {
    files.set('csrf_token', csrf);

    return request(path, { method: 'POST', body: files });
  };

  const picker = await request('/login/');
  assert.equal(picker.status, 200);
  const selected = await form('/login/', { player_id: String(rider.player_id) });
  assert.equal(selected.status, 302);
  // Reading the import form obtains the new session's token without triggering workout sync.
  const profile = await request(`/profile/${rider.username}/`);
  assert.equal(profile.status, 200);

  return { request, form, upload };
}
