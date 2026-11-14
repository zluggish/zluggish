import { AccountsService } from '#src/services/auth.service';
import { riderSchema } from '#src/repositories/accounts.repository';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('malformed account identities are rejected before any repository access', (t) => {
  const lookup = t.mock.method(AccountsService.prototype, 'get', () => {
    throw new Error('Unexpected lookup');
  });

  for (const identity of ['', '1', '1:2:3', '-1:2', '1:-2', '1.5:2', '1:2.5', ' 1:2', '1:2 ', '1e2:3']) {
    assert.equal(AccountsService.prototype.identity(identity), null);
  }

  assert.equal(lookup.mock.callCount(), 0);
});

await test('account identities require an existing rider with the current auth version', (t) => {
  const rider = riderSchema.parse({
    player_id: 7,
    username: 'rider@example.test',
    first_name: 'Test',
    last_name: 'Rider',
    pass_hash: null,
    auth_version: 3,
    official_player_id: null,
    is_admin: 0,
  });

  t.mock.method(AccountsService.prototype, 'get', (id: number) => (id === rider.player_id ? rider : null));
  const service = AccountsService.prototype;

  assert.equal(service.identityOf(rider), '7:3');
  assert.equal(service.identity('7:3'), rider);
  assert.equal(service.identity('7:2'), null);
  assert.equal(service.identity('7:4'), null);
  assert.equal(service.identity('8:3'), null);
});
