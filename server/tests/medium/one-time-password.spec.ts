import { Effect, Schema } from 'effect';
import { ManagementService } from '#src/services/management.service';
import { createWebApp } from '#src/http/web-app';
import { inputValue } from '#tests/support/html';
import { runtimeFixture } from '#tests/support/runtime';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const origin = 'http://local:8080';
const tokenPath = '/auth/realms/zwift/protocol/openid-connect/token';
const codeFormat = /^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/;
const issued = Schema.Struct({
  player_id: Schema.Number,
  revision: Schema.Number,
  password_change_required: Schema.Boolean,
  one_time_password: Schema.String,
});

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

  const adminCookie = `zluggish_web_session=${admin.id}`;

  // The browser cannot choose a one-time password: the server makes it.
  const chosenByBrowser = await web.request(
    `${origin}/api/manage/users`,
    post(adminCookie, admin.session.csrf, {
      operation: crypto.randomUUID(),
      user: { username: 'new', first_name: 'New', last_name: 'Rider', password: 'K7MQ-2XPT-9WRD', one_time: true },
    }),
  );
  assert.equal(chosenByBrowser.status, 400);

  const operation = crypto.randomUUID();
  const request = post(adminCookie, admin.session.csrf, {
    operation,
    user: { username: 'new', first_name: 'New', last_name: 'Rider', one_time: true },
  });
  const created = await web.request(`${origin}/api/manage/users`, request);
  assert.equal(created.status, 201);
  const rider = Schema.decodeUnknownSync(issued)(await created.json());
  assert.equal(rider.password_change_required, true);
  assert.match(rider.one_time_password, codeFormat);
  const code = rider.one_time_password;

  // It is shown once: a retried request gets the user, but not the password.
  const retried = await web.request(`${origin}/api/manage/users`, request);
  assert.equal(retried.status, 201);
  const replay = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(await retried.json());
  assert.equal(replay.player_id, rider.player_id);
  assert.equal('one_time_password' in replay, false);
  assert.equal(
    f.accounts.db.prepare('SELECT count(*) AS n FROM management_operation WHERE result LIKE ?').get(`%${code}%`)?.n,
    0,
  );

  // The game cannot ask for a new password, so both game sign-ins refuse the one-time password.
  const token = await f.app.request(tokenPath, {
    method: 'POST',
    body: new URLSearchParams({ username: 'new', password: code }),
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
      password: code,
    }),
  });
  assert.equal(launcher.status, 200);
  assert.match(await launcher.text(), /one-time password/);

  const anonymous = await web.request(`${origin}/api/setup`);
  const csrfCookie = anonymous.headers.getSetCookie()[0]!.split(';', 1)[0]!;
  const { csrf } = Schema.decodeUnknownSync(Schema.Struct({ csrf: Schema.String }))(await anonymous.json());
  const signedIn = await web.request(
    `${origin}/api/session`,
    post(csrfCookie, csrf, { username: 'new', password: code }),
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
    post(session, signedInBody.csrf, { current_password: code, password: code }),
  );
  assert.equal(reused.status, 400);
  assert.equal(f.accounts.get(rider.player_id)!.password_change_required, 1);

  const chosen = await web.request(
    `${origin}/api/me/password`,
    post(session, signedInBody.csrf, { current_password: code, password: 'chosen-password' }),
  );
  assert.equal(chosen.status, 200);
  const after = f.accounts.get(rider.player_id)!;
  assert.equal(after.password_change_required, 0);
  assert.equal(await f.accounts.verify(after, code), false);

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
      { username: 'new', first_name: 'New', last_name: '', one_time: true },
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

await test('an administrator can reset a password to a one-time password shown only once', async (t) => {
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

  const regular = await f.effects.runPromise(
    service.create(
      admin.id,
      { username: 'regular', first_name: 'Regular', last_name: '', password: 'test-password' },
      crypto.randomUUID(),
    ),
  );
  assert.equal('one_time_password' in regular, false);
  const before = f.accounts.get(regular.player_id)!;

  const operation = crypto.randomUUID();
  const request = { revision: regular.revision, operation };
  const reset = Schema.decodeUnknownSync(issued)(
    await f.effects.runPromise(service.mutate(admin.id, regular.player_id, 'one-time-password', request)),
  );
  assert.match(reset.one_time_password, codeFormat);
  assert.equal(reset.password_change_required, true);

  const after = f.accounts.get(regular.player_id)!;
  assert.equal(after.password_change_required, 1);
  assert.equal(after.auth_version, before.auth_version + 1);
  assert.equal(await f.accounts.verify(after, 'test-password'), false);
  assert.equal(await f.accounts.verify(after, reset.one_time_password), true);

  const replay = await f.effects.runPromise(service.mutate(admin.id, regular.player_id, 'one-time-password', request));
  assert.equal('one_time_password' in replay, false);
  assert.equal(f.accounts.get(regular.player_id)!.revision, after.revision);

  // Each reset makes a new password and the earlier one stops working.
  const again = Schema.decodeUnknownSync(issued)(
    await f.effects.runPromise(
      service.mutate(admin.id, regular.player_id, 'one-time-password', {
        revision: after.revision,
        operation: crypto.randomUUID(),
      }),
    ),
  );
  assert.notEqual(again.one_time_password, reset.one_time_password);
  assert.equal(await f.accounts.verify(f.accounts.get(regular.player_id)!, reset.one_time_password), false);

  await assert.rejects(
    f.effects.runPromise(
      service.mutate(admin.id, owner.player_id, 'one-time-password', {
        revision: owner.revision,
        operation: crypto.randomUUID(),
      }),
    ),
    /own password/i,
  );
});
