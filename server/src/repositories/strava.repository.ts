import { CryptoRepository } from '#src/repositories/crypto.repository';
import { AssetFiles } from '#src/repositories/files.repository';
import { CookieSession, SessionRepository } from '#src/repositories/session.repository';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { z } from 'zod';

const site = 'https://www.strava.com';
const selectUrl = `${site}/upload/select`;
const marker = 'Upload and Sync Your Activities';
const redirect = 'https://launcher.zwift.com/authorization';

const tokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.number(),
});

export interface StravaToken {
  clientId: string;
  clientSecret: string;
  access: string;
  refresh: string;
  expiresAt: number;
}

async function oauth(form: Record<string, string>) {
  const response = await fetch(`${site}/oauth/token`, {
    method: 'POST',
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) throw new Error(`Strava OAuth failed: ${response.status}`);

  return tokenResponse.parse(await response.json());
}

function cookieSession(cookie: string) {
  return new CookieSession('strava.com', { _strava4_session: cookie });
}

const firstKey = (data: Record<string, string>, ...keys: string[]) => keys.find((key) => key in data) ?? keys[0] ?? '';

const video = new Set(['.mp4', '.mov', '.m4v']);

async function uploadPhoto(session: CookieSession, token: string, athlete: number, photo: string) {
  const uid = new CryptoRepository().randomUUID();
  const kind = video.has(extname(photo).toLowerCase()) ? '2' : '1';

  const meta = new URLSearchParams({
    athlete_id: String(athlete),
    uuid: uid,
    taken_at: String(Math.floor(statSync(photo).mtimeMs)),
  });

  if (kind === '2') meta.set('media_type', kind);

  const metadata = await session.request(`${site}/photos/metadata`, {
    method: 'PUT',
    headers: { 'X-CSRF-Token': token },
    body: meta,
  });

  if (!metadata.ok) throw new Error('Photo metadata failed');

  const target = z.object({ uri: z.url(), header: z.record(z.string(), z.string()) }).parse(await metadata.json());

  const stored = await fetch(target.uri, {
    method: 'PUT',
    headers: target.header,
    body: readFileSync(photo),
    signal: AbortSignal.timeout(120_000),
  });

  if (!stored.ok) throw new Error('Photo upload failed');

  return { uid, kind };
}

async function updateActivity(session: CookieSession, id: string, name: string, photos: readonly string[]) {
  const edit = await session.request(`${site}/activities/${id}/edit`);

  if (!edit.ok) throw new Error('Unable to get activity edit page');
  const text = await edit.text();
  const token = /name="authenticity_token" value="([^"]+)"/.exec(text)?.[1];
  const athlete = /var athleteId = (\d+);/.exec(text)?.[1];
  const form = /<form class="edit_activity"[\s\S]*?<\/form>/.exec(text)?.[0];

  if (token === undefined || athlete === undefined || form === undefined)
    throw new Error('Cannot parse the Strava edit page');

  const data = new StravaRepository().parseForm(form);

  data._method ??= 'patch';

  if (name) data[firstKey(data, 'activity[name]', 'name')] = name;

  data[firstKey(data, 'activity[sport_type]', 'sport_type', 'activity[type]', 'type')] = 'VirtualRide';

  let rank = 0;

  for (const photo of photos) {
    const { uid, kind } = await uploadPhoto(
      session,
      new SessionRepository().unescapeHtml(token),
      Number(athlete),
      photo,
    );

    data[`photos[${uid}][caption]`] = '';
    data[`photos[${uid}][rank]`] = String(rank++);
    data[`photos[${uid}][media_type]`] = kind;
  }

  const saved = await session.request(`${site}/activities/${id}`, {
    method: 'POST',
    body: new URLSearchParams(data),
  });

  if (!saved.ok) throw new Error('Failed to save activity');
}

const progress = z.array(
  z.object({
    workflow: z.string().optional(),
    id: z.union([z.number(), z.string()]).optional(),
    activity: z.object({ id: z.union([z.number(), z.string()]) }).optional(),
  }),
);

/** Remote upload accepted -> processing -> success or error/empty/timeout; bounded to 60 polls. */
async function waitReady(session: CookieSession, upload: string, delay = 1000) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await session.request(`${site}/upload/progress.json?${new URLSearchParams({ 'ids[]': upload })}`);

    const [item] = progress.parse(await response.json());

    if (item?.workflow === 'success') return item;

    if (item?.workflow === 'error' || item?.workflow === 'empty') throw new Error(`Upload failed: ${item.workflow}`);
    await new Promise((done) => setTimeout(done, delay));
  }

  throw new Error('Upload timed out');
}

export class StravaRepository {
  authorizationUrl(clientId: string, state: string) {
    return `${site}/oauth/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirect,
      approval_prompt: 'auto',
      response_type: 'code',
      scope: 'activity:write',
      state,
    })}`;
  }
  readToken(file: string): StravaToken | null {
    if (!existsSync(file)) return null;

    const [clientId, clientSecret, access, refresh, expires] = readFileSync(file, 'utf8').split(/\r?\n/, 5);

    const expiresAt = Number(expires);

    if (!clientId || !clientSecret || !access || !refresh || !Number.isFinite(expiresAt))
      throw new Error('Invalid Strava token file');

    return { clientId, clientSecret, access, refresh, expiresAt };
  }
  writeToken(file: string, token: StravaToken) {
    new AssetFiles().writeDurable(
      file,
      `${token.clientId}\n${token.clientSecret}\n${token.access}\n${token.refresh}\n${token.expiresAt}\n`,
      true,
    );
  }
  async exchangeCode(clientId: string, clientSecret: string, code: string): Promise<StravaToken> {
    const result = await oauth({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
    });

    return {
      clientId,
      clientSecret,
      access: result.access_token,
      refresh: result.refresh_token,
      expiresAt: result.expires_at,
    };
  }
  async uploadPaid(file: string, fit: Uint8Array, name: string, now = Date.now() / 1000) {
    let token = this.readToken(file);

    if (!token) return false;

    if (now > token.expiresAt) {
      const result = await oauth({
        client_id: token.clientId,
        client_secret: token.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: token.refresh,
      });

      token = {
        ...token,
        access: result.access_token,
        refresh: result.refresh_token,
        expiresAt: result.expires_at,
      };
      this.writeToken(file, token);
    }

    const form = new FormData();
    form.set('data_type', 'fit');
    form.set('name', name);
    form.set('file', new SessionRepository().binaryBlob(fit), 'activity.fit');

    const response = await fetch(`${site}/api/v3/uploads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.access}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) throw new Error(`Strava upload failed: ${response.status}`);

    return true;
  }
  async checkSession(cookie: string) {
    const response = await cookieSession(cookie).request(selectUrl);

    const response1 = await response.text();

    return response1.includes(marker);
  }
  parseForm(form: string) {
    const data: Record<string, string> = {};

    for (const [tag = ''] of form.matchAll(/<input\b[^>]*>/g)) {
      if (/\bdisabled\b|\btype=["'](?:submit|button|file)["']/.test(tag)) continue;
      const name = /name="([^"]+)"/.exec(tag)?.[1];

      if (name === undefined) continue;
      const value = new SessionRepository().unescapeHtml(/value="([^"]*)"/.exec(tag)?.[1] ?? '');

      if (/type="checkbox"/.test(tag)) {
        if (/\bchecked\b/.test(tag)) data[new SessionRepository().unescapeHtml(name)] = value || '1';
      } else data[new SessionRepository().unescapeHtml(name)] = value;
    }

    for (const [tag = ''] of form.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/g)) {
      if (/\bdisabled\b/.test(tag)) continue;
      const name = /name="([^"]+)"/.exec(tag)?.[1];
      const options = tag.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g).toArray();

      if (name === undefined || options.length === 0) continue;

      const chosen = options.find((option) => (option[1] ?? '').includes('selected'));

      const option = chosen ?? options[0];

      data[new SessionRepository().unescapeHtml(name)] = new SessionRepository().unescapeHtml(
        /value="([^"]*)"/.exec(option?.[1] ?? '')?.[1] ?? option?.[2] ?? '',
      );
    }

    for (const [tag = ''] of form.matchAll(/<textarea\b[^>]*>[\s\S]*?<\/textarea>/g)) {
      const name = /name="([^"]+)"/.exec(tag)?.[1];

      if (name === undefined) continue;
      data[new SessionRepository().unescapeHtml(name)] = new SessionRepository().unescapeHtml(
        />([\s\S]*)<\/textarea>/.exec(tag)?.[1] ?? '',
      );
    }

    return data;
  }
  async uploadFree(
    cookie: string,
    filename: string,
    fit: Uint8Array,
    name: string,
    photos: readonly string[] = [],
    delay = 1000,
  ) {
    const session = cookieSession(cookie);
    const select = await session.request(selectUrl);
    const text = await select.text();

    if (!text.includes(marker)) throw new Error('Invalid Strava session');

    const token =
      /<meta name="csrf-token" content="([^"]+)"/.exec(text)?.[1] ??
      /name="authenticity_token" value="([^"]+)"/.exec(text)?.[1];

    if (token === undefined) throw new Error('Cannot find the upload token');

    const form = new FormData();
    form.set('_method', 'post');
    form.set('authenticity_token', new SessionRepository().unescapeHtml(token));
    form.set('files[]', new SessionRepository().binaryBlob(fit), filename);

    const response = await session.request(`${site}/upload/files`, {
      method: 'POST',
      body: form,
    });

    const body = await response.text();

    if (!body.includes('workflow')) throw new Error('Strava rejected the upload');

    for (const upload of progress.parse(JSON.parse(body))) {
      if (upload.id === undefined) continue;
      const item = await waitReady(session, String(upload.id), delay);
      const id = item.activity?.id ?? item.id;

      if (id === undefined) throw new Error('No activity ID in upload response');
      await updateActivity(session, String(id), name, photos);
    }
  }
}
