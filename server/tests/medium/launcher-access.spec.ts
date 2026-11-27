import { AccessGroupsService } from '#src/services/access-groups.service';
import { ACCESS_PUBLIC_URL, ACCESS_WEB } from '#tests/support/access';
import { mediumFixture } from '#tests/medium/support';
import { inputValue } from '#tests/support/html';
import { t as translate } from '#src/i18n/index';
import assert from 'node:assert/strict';
import { Schema } from 'effect';
import type { TestContext } from 'node:test';
import { test } from 'node:test';

const ANNA = 'anna@example.com';

async function fixture(t: TestContext, access = true) {
  const f = await mediumFixture(t, access ? ACCESS_PUBLIC_URL : null, true, {}, access ? ACCESS_WEB : {});
  const lines: Array<string> = [];
  f.accounts.repositories.loggingRepository.configure({
    level: 'VERBOSE',
    sink: (line) => {
      lines.push(line);
    },
  });
  const service = f.effects.runSync(AccessGroupsService);
  const group = f.effects.runSync(service.create('Berg family')).id;
  f.effects.runSync(service.addEmail(group, ANNA));
  f.effects.runSync(service.addRider(group, f.rider.player_id));

  /** A launcher signed in through Access as `email`, or with the given device token; `null` for none. */
  const launcher = (email: string | null = ANNA, token = email === null ? null : service.deviceToken(email)) => {
    let cookie = '';
    let csrf = '';

    const headers = (init: HeadersInit = {}) => {
      const result = new Headers(init);
      result.set('Cookie', [cookie, token === null ? '' : `zluggish_access=${token}`].filter(Boolean).join('; '));

      return result;
    };

    const request = async (path: string, init: RequestInit = {}) => {
      const response = await f.app.request(path, { ...init, headers: headers(init.headers) });
      cookie = response.headers.getSetCookie().at(-1)?.split(';', 1)[0] ?? cookie;
      csrf = inputValue(await response.clone().text(), 'csrf_token') ?? csrf;

      return response;
    };

    const choose = (player: number, fields: Record<string, string> = {}, init: RequestInit = {}) =>
      request('/login/', {
        ...init,
        method: 'POST',
        body: new URLSearchParams({ csrf_token: csrf, player_id: String(player), ...fields }),
      });

    return {
      request,
      choose,
      setCookie: (value: string) => {
        cookie = value;
      },
      cookie: () => cookie,
    };
  };

  return { ...f, service, group, launcher, lines };
}

async function text(response: Promise<Response>) {
  const resolved = await response;

  return resolved.text();
}

const pageModel = Schema.Struct({
  kind: Schema.String,
  title: Schema.String,
  message: Schema.optional(Schema.String),
  accessEmail: Schema.optional(Schema.NullOr(Schema.String)),
  retry: Schema.optional(Schema.Struct({ href: Schema.String, label: Schema.String })),
  forms: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      fields: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.optional(Schema.Unknown) })),
    }),
  ),
});

/** The launcher page model the server embedded in the page, without its per-session token. */
function props(html: string) {
  const json = /<script type="application\/json" id="launcher-props">(.*?)<\/script>/s.exec(html)?.[1];
  assert.ok(json, 'the page embeds its model');

  return Schema.decodeUnknownSync(pageModel)(JSON.parse(json));
}

function riderIds(html: string) {
  return props(html).forms.flatMap((form) =>
    form.fields.filter((field) => field.name === 'player_id').map((field) => Number(field.value)),
  );
}

await test('without Access sign-in configured the picker lists every rider', async (t) => {
  const f = await fixture(t, false);
  const page = await text(f.launcher(null).request('/login/'));

  assert.deepEqual(
    riderIds(page).toSorted((a, b) => a - b),
    [f.rider.player_id, f.other.player_id].toSorted((a, b) => a - b),
  );
  assert.doesNotMatch(page, /Cloudflare/);
});

for (const [name, token] of [
  ['no sign-in', null],
  ['a forged sign-in', `access-device-v1:${Buffer.from(ANNA).toString('base64url')}:9999999999999|00`],
  ['a sign-in for another purpose', 'access-ticket-v1:x:y:9999999999999|00'],
  ['an empty sign-in', ''],
] as const) {
  await test(`${name} shows the sign-in page and lists no riders`, async (t) => {
    const f = await fixture(t);
    const response = await f.launcher(ANNA, token).request('/login/');
    const page = await response.text();

    assert.equal(response.status, 200);
    assert.match(page, /Sign in to choose a rider/);
    assert.deepEqual(riderIds(page), []);
    assert.doesNotMatch(page, /Medium Rider|Other Rider/);
    assert.equal(f.accounts.repositories.accessGroupsRepository.seen().length, 0);
  });
}

await test('an expired sign-in shows the sign-in page', async (t) => {
  const f = await fixture(t);
  const token = f.service.deviceToken(ANNA);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 31 * 86_400_000 });

  assert.deepEqual(riderIds(await text(f.launcher(ANNA, token).request('/login/'))), []);
});

await test('a signed-in email sees only its riders and who Cloudflare says is signed in', async (t) => {
  const f = await fixture(t);
  const page = await text(f.launcher('Anna@Example.com').request('/login/'));

  assert.deepEqual(riderIds(page), [f.rider.player_id]);
  assert.doesNotMatch(page, /Other Rider/);
  assert.match(page, /Signed in to Cloudflare as anna@example\.com/);
});

await test('an email without riders is told so and recorded for the administrator', async (t) => {
  const f = await fixture(t);
  const page = await text(f.launcher('lisa@example.com').request('/login/'));

  assert.match(page, /No riders for lisa@example\.com yet/);
  assert.deepEqual(riderIds(page), []);
  assert.deepEqual(
    f.accounts.repositories.accessGroupsRepository.seen().map((row) => row.email),
    ['lisa@example.com'],
  );
});

await test('choosing a rider outside the groups answers like an unknown rider on both sign-in paths', async (t) => {
  const f = await fixture(t);
  const launcher = f.launcher();
  await launcher.request('/login/');

  const unknown = await text(launcher.choose(99_999, { step: 'password', password: 'test-password' }));
  assert.equal(props(unknown).message, translate('accounts_user_not_found'));

  const password = await launcher.choose(f.other.player_id, { step: 'password', password: 'test-password' });
  assert.equal(password.status, 200);
  const outsidePage = props(await password.text());
  assert.deepEqual(outsidePage, props(unknown));
  assert.equal(outsidePage.message, translate('accounts_user_not_found'));

  // The remembered-rider path: a valid remember cookie for a rider outside the groups is ignored.
  launcher.setCookie(`${launcher.cookie()}; zluggish_remember_${f.other.player_id}=${f.sessions.remember(f.other)}`);
  const remembered = await launcher.choose(f.other.player_id);
  assert.equal(remembered.status, 200);
  assert.equal(props(await remembered.text()).message, translate('accounts_user_not_found'));
  assert.ok(f.lines.some((line) => line.includes('auth.login_outside_group')));

  // The rider in the group still signs in.
  const allowed = await launcher.choose(f.rider.player_id, { step: 'password', password: 'test-password' });
  assert.equal(allowed.status, 302);
});

await test('an unidentified POST gets 401 and signs nobody in', async (t) => {
  const f = await fixture(t);
  const identified = f.launcher();
  await identified.request('/login/');
  const anonymous = f.launcher(null);
  anonymous.setCookie(identified.cookie());

  const response = await anonymous.choose(
    f.rider.player_id,
    { step: 'password', password: 'test-password' },
    { headers: { Accept: 'application/json' } },
  );

  assert.equal(response.status, 401);
  assert.equal(response.headers.get('Location'), null);
});

await test('the sign-in cookie and the email never reach the logs', async (t) => {
  const f = await fixture(t);
  const token = f.service.deviceToken(ANNA);
  await f.launcher(ANNA, token).request('/login/');
  await f.launcher('mallory@example.com', 'forged-token-forged-token').request('/login/');
  await f.launcher('lisa@example.com').request('/login/');

  const logged = [...f.lines, ...f.world.lifecycle.log.recentEntries()].join('\n');
  assert.match(logged, /auth\.launcher_identity/);
  assert.match(logged, /invalid/);
  assert.ok(!logged.includes(token));
  assert.doesNotMatch(logged, /forged-token/);
  assert.doesNotMatch(logged, /anna@example\.com|mallory@example\.com|lisa@example\.com/);
});
