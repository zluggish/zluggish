import { validateConfig } from '#src/config/index';
import { createWebApp } from '#src/http/web-app';
import { AccessGroupsService } from '#src/services/access-groups.service';
import { mediumFixture } from '#tests/medium/support';
import { ACCESS_AUDIENCE, ACCESS_PUBLIC_URL, ACCESS_TEAM, ACCESS_WEB } from '#tests/support/access';
import { t as translate } from '#src/i18n/index';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { Schema } from 'effect';

const ANNA = 'anna@example.com';

const signer = generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });

/** A signing key as the Access certs endpoint lists it. */
function jwk(key: KeyObject, kid: string) {
  const exported = key.export({ format: 'jwk' });

  return { kid, kty: exported.kty ?? '', n: exported.n ?? '', e: exported.e ?? '' };
}

const encode = (json: string) => Buffer.from(json).toString('base64url');

/** Token claims a test may override; `email: undefined` leaves it out. */
interface Claims {
  iss?: string;
  aud?: Array<string>;
  exp?: number;
  nbf?: number;
  email?: string | undefined;
}

/** An Access token as Cloudflare would sign it, with any claim overridden. */
function token(
  claims: Claims = {},
  { key = signer.privateKey, kid = 'one', alg = 'RS256' }: { key?: KeyObject; kid?: string; alg?: string } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const head = encode(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const body = encode(
    JSON.stringify({
      iss: `https://${ACCESS_TEAM}`,
      aud: [ACCESS_AUDIENCE],
      exp: now + 300,
      iat: now,
      email: ANNA,
      ...claims,
    }),
  );

  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
}

async function fixture(t: TestContext) {
  const f = await mediumFixture(t, ACCESS_PUBLIC_URL, true, ACCESS_WEB);
  const keys = t.mock.method(f.accounts.repositories.cloudflareAccessRepository, 'keys', () =>
    Promise.resolve([jwk(signer.publicKey, 'one')]),
  );
  const service = f.effects.runSync(AccessGroupsService);
  const group = f.effects.runSync(service.create('Berg family')).id;
  f.effects.runSync(service.addEmail(group, ANNA));
  f.effects.runSync(service.addRider(group, f.rider.player_id));
  const web = createWebApp(f);

  /** A launcher with its own cookie jar. */
  const launcher = () => {
    const jar = new Map<string, string>();

    const request = async (path: string, headers: Record<string, string> = {}) => {
      const response = await f.app.request(path, {
        headers: { ...headers, Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') },
      });

      for (const line of response.headers.getSetCookie()) {
        const [pair = ''] = line.split(';', 1);
        const index = pair.indexOf('=');
        jar.set(pair.slice(0, index), pair.slice(index + 1));
      }

      return response;
    };

    /** Start the sign-in and return the state the launcher was sent to the web app with. */
    const start = async () => {
      const response = await request('/login/access');
      assert.equal(response.status, 302);
      const location = new URL(response.headers.get('Location') ?? '');
      assert.equal(`${location.origin}${location.pathname}`, `${ACCESS_PUBLIC_URL}/launcher/link`);

      return location.searchParams.get('state') ?? '';
    };

    return { request, start, jar };
  };

  const link = (state: string, assertion: string | null = token()) =>
    web.request(`/launcher/link?state=${encodeURIComponent(state)}`, {
      headers: assertion === null ? {} : { 'Cf-Access-Jwt-Assertion': assertion },
    });

  return { ...f, keys, web, launcher, link, group, service };
}

/** The ticket path on secure.zwift.com that a successful link redirects to. */
function ticketPath(response: Response) {
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('Location') ?? '');
  assert.equal(location.origin, 'https://secure.zwift.com');
  assert.equal(location.pathname, '/login/');

  return `${location.pathname}${location.search}`;
}

const pageModel = Schema.Struct({
  kind: Schema.String,
  title: Schema.String,
  message: Schema.optional(Schema.String),
  accessEmail: Schema.optional(Schema.NullOr(Schema.String)),
  retry: Schema.optional(Schema.Struct({ href: Schema.String, label: Schema.String })),
  signIn: Schema.optional(Schema.Struct({ href: Schema.String, label: Schema.String })),
  forms: Schema.Array(
    Schema.Struct({
      fields: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.optional(Schema.Unknown) })),
    }),
  ),
});

async function props(response: Response) {
  const json = /<script type="application\/json" id="launcher-props">(.*?)<\/script>/s.exec(await response.text())?.[1];
  assert.ok(json, 'the page embeds its model');

  return Schema.decodeUnknownSync(pageModel)(JSON.parse(json));
}

async function status(response: Response | Promise<Response>) {
  const resolved = await response;

  return resolved.status;
}

const riderIds = (model: typeof pageModel.Type) =>
  model.forms.flatMap((form) =>
    form.fields.filter((field) => field.name === 'player_id').map((field) => Number(field.value)),
  );

await test('a launcher signs in through Access once and then lists only its riders', async (t) => {
  const f = await fixture(t);
  const launcher = f.launcher();

  const before = await props(await launcher.request('/login/'));
  assert.equal(before.kind, 'message');
  assert.equal(before.message, translate('access_connect_message'));
  assert.deepEqual(before.signIn, { href: '/login/access', label: translate('access_sign_in') });
  assert.equal(before.retry, undefined);

  const state = await launcher.start();
  const path = ticketPath(await f.link(state));
  const back = await launcher.request(path);
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('Location'), '/login/');
  const cookie = back.headers.getSetCookie().find((line) => line.startsWith('zluggish_access='));
  assert.match(cookie ?? '', /HttpOnly/);
  assert.match(cookie ?? '', /Path=\/login\//);
  assert.match(cookie ?? '', /SameSite=Lax/);
  assert.match(cookie ?? '', /Max-Age=2592000/);

  const picker = await props(await launcher.request('/login/'));
  assert.equal(picker.kind, 'login');
  assert.deepEqual(riderIds(picker), [f.rider.player_id]);
  assert.equal(picker.accessEmail, ANNA);

  // The ticket works once.
  const again = await props(await launcher.request(path));
  assert.equal(again.message, translate('access_link_expired'));
});

await test('a ticket only works for the launcher session that started the sign-in', async (t) => {
  const f = await fixture(t);
  const first = f.launcher();
  const path = ticketPath(await f.link(await first.start()));

  const second = f.launcher();
  await second.start();
  const refused = await props(await second.request(path));
  assert.equal(refused.message, translate('access_link_expired'));
  assert.equal(second.jar.has('zluggish_access'), false);

  // A forged or altered ticket fails too.
  const altered = await props(await first.request(path.replace(/ticket=[^&]{4}/, 'ticket=AAAA')));
  assert.equal(altered.message, translate('access_link_expired'));
});

await test('a ticket expires after a minute', async (t) => {
  const f = await fixture(t);
  const launcher = f.launcher();
  const path = ticketPath(await f.link(await launcher.start()));

  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 61_000 });
  const late = await props(await launcher.request(path));
  assert.equal(late.message, translate('access_link_expired'));
});

for (const [name, assertion] of [
  ['no token', null],
  ['a malformed token', 'not-a-token'],
  ['another audience', token({ aud: ['b'.repeat(64)] })],
  ['another team', token({ iss: 'https://other.cloudflareaccess.com' })],
  ['an expired token', token({ exp: Math.floor(Date.now() / 1000) - 3600 })],
  ['a token not valid yet', token({ nbf: Math.floor(Date.now() / 1000) + 3600 })],
  ['a token without an email', token({ email: undefined })],
  ['a token signed by another key', token({}, { key: stranger.privateKey })],
  ['an unsigned token', token({}, { alg: 'none' })],
] as const) {
  await test(`the web app refuses ${name}`, async (t) => {
    const f = await fixture(t);
    const response = await f.link(await f.launcher().start(), assertion);

    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Location'), null);
  });
}

await test('the web app refuses a state the launcher could not have made', async (t) => {
  const f = await fixture(t);

  assert.equal(await status(f.link('short')), 403);
  assert.equal(f.keys.mock.callCount(), 0);
});

await test('unknown key ids fetch the keys again, at most once a minute', async (t) => {
  const f = await fixture(t);
  const state = await f.launcher().start();

  assert.equal(await status(f.link(state)), 302);
  assert.equal(await status(f.link(state)), 302);
  assert.equal(f.keys.mock.callCount(), 1);

  // Cloudflare rotated its keys: the next unknown id fetches them again.
  f.keys.mock.mockImplementation(() => Promise.resolve([jwk(stranger.publicKey, 'two')]));
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 61_000 });
  assert.equal(await status(f.link(state, token({}, { key: stranger.privateKey, kid: 'two' }))), 302);
  assert.equal(f.keys.mock.callCount(), 2);
  assert.equal(await status(f.link(state, token({}, { kid: 'three' }))), 403);
  assert.equal(f.keys.mock.callCount(), 2);
});

await test('a forged device cookie is ignored', async (t) => {
  const f = await fixture(t);
  const launcher = f.launcher();
  launcher.jar.set('zluggish_access', `access-device-v1:${Buffer.from(ANNA).toString('base64url')}:9999999999999|00`);

  const page = await props(await launcher.request('/login/'));
  assert.equal(page.kind, 'message');
  assert.deepEqual(riderIds(page), []);
});

await test('an email without riders can check again or sign in with another email', async (t) => {
  const f = await fixture(t);
  const launcher = f.launcher();
  await launcher.request(ticketPath(await f.link(await launcher.start(), token({ email: 'lisa@example.com' }))));

  const page = await props(await launcher.request('/login/'));
  assert.equal(page.title, translate('access_no_riders_title', { value1: 'lisa@example.com' }));
  assert.equal(page.retry?.href, '/login/');
  assert.equal(page.signIn?.href, '/login/access');
  assert.equal(f.accounts.repositories.accessGroupsRepository.seen()[0]?.email, 'lisa@example.com');

  // Signing in again replaces the email this launcher is signed in with.
  await launcher.request(ticketPath(await f.link(await launcher.start())));
  assert.deepEqual(riderIds(await props(await launcher.request('/login/'))), [f.rider.player_id]);
});

await test('Access sign-in needs an https public URL', () => {
  assert.throws(
    () =>
      validateConfig({
        network: { web: { ...ACCESS_WEB, publicUrl: null } },
      }),
    /network\.web\.cloudflareAccess/,
  );
});
