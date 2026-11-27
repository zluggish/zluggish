import { Schema } from 'effect';
import { ManagementService } from '#src/services/management.service';
import { mediumWeb } from '#tests/medium/support';
import { runtimeFixture } from '#tests/support/runtime';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const origin = 'http://local:8080';
const tokenPath = '/auth/realms/zwift/protocol/openid-connect/token';

const listed = Schema.Struct({
  users: Schema.Array(
    Schema.Struct({
      player_id: Schema.Number,
      revision: Schema.Number,
      last_login: Schema.NullOr(Schema.Number),
      last_ride: Schema.NullOr(Schema.Number),
    }),
  ),
});

await test('the user list shows when each user last signed in and last rode', async (t) => {
  const f = runtimeFixture(t);
  const service = f.effects.runSync(ManagementService);

  const owner = await f.effects.runPromise(
    service.setup({
      mode: 'new',
      key: f.effects.runSync(service.issueSetupKey())!,
      username: 'owner',
      first_name: 'Owen',
      last_name: 'Owner',
      password: 'test-password',
    }),
  );
  const rider = await f.accounts.create('Olle Berg', 'test-password', 'olle');
  const admin = mediumWeb(f, owner);

  const list = async () => {
    const response = await admin.request('/api/manage/users');
    assert.equal(response.status, 200);
    const { users } = Schema.decodeUnknownSync(listed)(await response.json());

    return (id: number) => users.find((user) => user.player_id === id)!;
  };

  const before = await list();
  assert.equal(before(rider.player_id).last_login, null);
  assert.equal(before(rider.player_id).last_ride, null);

  // The game signs in with a login name and password. The sign-in leaves the account revision as it was.
  const started = Date.now();
  const game = await f.app.request(tokenPath, {
    method: 'POST',
    body: new URLSearchParams({ username: 'olle', password: 'test-password' }),
  });
  assert.equal(game.status, 200);
  const tokens = Schema.decodeUnknownSync(Schema.Struct({ refresh_token: Schema.String }))(await game.json());
  const signedIn = (await list())(rider.player_id);
  assert.ok(signedIn.last_login !== null && signedIn.last_login >= started && signedIn.last_login <= Date.now());
  assert.equal(signedIn.revision, rider.revision);

  // A token refresh does not count as a sign-in.
  f.accounts.db.prepare('UPDATE user SET last_login = 1000 WHERE player_id = ?').run(rider.player_id);
  const refreshed = await f.app.request(tokenPath, {
    method: 'POST',
    body: new URLSearchParams({ refresh_token: tokens.refresh_token }),
  });
  assert.equal(refreshed.status, 200);
  assert.equal((await list())(rider.player_id).last_login, 1000);

  // Signing in to the web app counts too.
  const anonymous = await admin.app.request(`${origin}/api/setup`);
  const cookie = anonymous.headers.getSetCookie()[0]!.split(';', 1)[0]!;
  const { csrf } = Schema.decodeUnknownSync(Schema.Struct({ csrf: Schema.String }))(await anonymous.json());
  const web = await admin.app.request(`${origin}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf, Origin: origin },
    body: JSON.stringify({ username: 'owner', password: 'test-password' }),
  });
  assert.equal(web.status, 200);
  assert.ok(((await list())(owner.player_id).last_login ?? 0) >= started);

  // The last ride is the start of the newest activity.
  f.accounts.db
    .prepare('INSERT INTO activity (player_id, start_date) VALUES (?, ?), (?, ?)')
    .run(rider.player_id, '2026-05-01T08:00:00Z', rider.player_id, '2026-03-01T08:00:00Z');
  const rode = await list();
  assert.equal(rode(rider.player_id).last_ride, Date.parse('2026-05-01T08:00:00Z'));
  assert.equal(rode(owner.player_id).last_ride, null);
});
