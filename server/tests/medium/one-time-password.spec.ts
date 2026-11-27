import { Effect, Schema } from 'effect';
import { ManagementService } from '#src/services/management.service';
import { createWebApp } from '#src/http/web-app';
import { inputValue } from '#tests/support/html';
import { runtimeFixture } from '#tests/support/runtime';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const origin = 'http://local:8080';
const tokenPath = '/auth/realms/zwift/protocol/openid-connect/token';

await test('a one-time password only lets the rider choose their own password', async (t) => {
  const f = runtimeFixture(t);
  const service = f.effects.runSync(ManagementService);
  const web = createWebApp(f);

  const owner = await f.effects.runPromise(
    service.setup({
      mode: 'new',
      key: f.effects.runSync(service.issueSetupKey())!,
      username: 'owner',
      first_name: 'First',
      last_name: 'Rider',
      password: 'test-password',
    }),
  );
  const admin = Effect.runSync(service.sessions.create(f.accounts.identityOf(owner), Date.now() + 900_000));

  const post = (cookie: string, csrf: string, body: unknown) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf, Origin: origin },
    body: JSON.stringify(body),
  });

  const created = await web.request(
    `${origin}/api/manage/users`,
    post(`zluggish_web_session=${admin.id}`, admin.session.csrf, {
      operation: crypto.randomUUID(),
      user: { username: 'new', first_name: 'New', last_name: 'Rider', password: 'K7MQ-2XPT-9WRD', one_time: true },
    }),
  );
  assert.equal(created.status, 201);
  const rider = Schema.decodeUnknownSync(
    Schema.Struct({ player_id: Schema.Number, password_change_required: Schema.Boolean }),
  )(await created.json());
  assert.equal(rider.password_change_required, true);

  // The game cannot ask for a new password, so both game sign-ins refuse the one-time password.
  const token = await f.app.request(tokenPath, {
    method: 'POST',
    body: new URLSearchParams({ username: 'new', password: 'K7MQ-2XPT-9WRD' }),
  });
  assert.equal(token.status, 401);
  const picker = await f.app.request('/login/');
  const gameCookie = picker.headers.getSetCookie().at(-1)!.split(';', 1)[0]!;
  const launcher = await f.app.request('/login/', {
    method: 'POST',
    headers: { Cookie: gameCookie },
    body: new URLSearchParams({
      csrf_token: inputValue(await picker.text(), 'csrf_token')!,
      player_id: String(rider.player_id),
      step: 'password',
      password: 'K7MQ-2XPT-9WRD',
    }),
  });
  assert.equal(launcher.status, 200);
  assert.match(await launcher.text(), /one-time password/);

  const anonymous = await web.request(`${origin}/api/setup`);
  const csrfCookie = anonymous.headers.getSetCookie()[0]!.split(';', 1)[0]!;
  const { csrf } = Schema.decodeUnknownSync(Schema.Struct({ csrf: Schema.String }))(await anonymous.json());
  const signedIn = await web.request(
    `${origin}/api/session`,
    post(csrfCookie, csrf, { username: 'new', password: 'K7MQ-2XPT-9WRD' }),
  );
  assert.equal(signedIn.status, 200);
  const session = signedIn.headers.getSetCookie().at(-1)!.split(';', 1)[0]!;
  const signedInBody = Schema.decodeUnknownSync(
    Schema.Struct({ csrf: Schema.String, user: Schema.Struct({ password_change_required: Schema.Boolean }) }),
  )(await signedIn.json());
  assert.equal(signedInBody.user.password_change_required, true);

  const me = await web.request(`${origin}/api/me`, { headers: { Cookie: session } });
  assert.equal(me.status, 200);

  for (const path of ['/api/me/profile', '/api/me/settings', '/api/me/activities', '/api/tls']) {
    const blocked = await web.request(`${origin}${path}`, { headers: { Cookie: session } });
    assert.equal(blocked.status, 403, path);
    assert.match(
      Schema.decodeUnknownSync(Schema.Struct({ message: Schema.String }))(await blocked.json()).message,
      /own password/,
    );
  }

  const reused = await web.request(
    `${origin}/api/me/password`,
    post(session, signedInBody.csrf, { current_password: 'K7MQ-2XPT-9WRD', password: 'K7MQ-2XPT-9WRD' }),
  );
  assert.equal(reused.status, 400);
  assert.equal(f.accounts.get(rider.player_id)!.password_change_required, 1);

  const chosen = await web.request(
    `${origin}/api/me/password`,
    post(session, signedInBody.csrf, { current_password: 'K7MQ-2XPT-9WRD', password: 'chosen-password' }),
  );
  assert.equal(chosen.status, 200);
  const after = f.accounts.get(rider.player_id)!;
  assert.equal(after.password_change_required, 0);
  assert.equal(await f.accounts.verify(after, 'K7MQ-2XPT-9WRD'), false);

  const game = await f.app.request(tokenPath, {
    method: 'POST',
    body: new URLSearchParams({ username: 'new', password: 'chosen-password' }),
  });
  assert.equal(game.status, 200);
});

await test('an administrator setting a password clears a pending one-time password', async (t) => {
  const f = runtimeFixture(t);
  const service = f.effects.runSync(ManagementService);

  const owner = await f.effects.runPromise(
    service.setup({
      mode: 'new',
      key: f.effects.runSync(service.issueSetupKey())!,
      username: 'owner',
      first_name: 'First',
      last_name: 'Rider',
      password: 'test-password',
    }),
  );
  const admin = Effect.runSync(service.sessions.create(f.accounts.identityOf(owner), Date.now() + 900_000));

  const created = await f.effects.runPromise(
    service.create(
      admin.id,
      { username: 'new', first_name: 'New', last_name: '', password: 'one-time', one_time: true },
      crypto.randomUUID(),
    ),
  );
  assert.equal(created.password_change_required, true);

  const regular = await f.effects.runPromise(
    service.create(
      admin.id,
      { username: 'regular', first_name: 'Regular', last_name: '', password: 'test-password' },
      crypto.randomUUID(),
    ),
  );
  assert.equal(regular.password_change_required, false);

  const reset = await f.effects.runPromise(
    service.mutate(admin.id, created.player_id, 'password', {
      revision: created.revision,
      operation: crypto.randomUUID(),
      password: 'set-by-admin',
    }),
  );
  assert.equal(reset.password_change_required, false);
  assert.equal(f.accounts.get(created.player_id)!.password_change_required, 0);
});
