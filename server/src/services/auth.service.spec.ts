import { AccountsService } from '#src/services/auth.service';
import { Schema } from 'effect';
import { riderSchema } from '#src/repositories/accounts.repository';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('malformed account identities are rejected before any repository access', (t) => {
  const lookup = t.mock.fn((_id: number): null => {
    throw new Error('Unexpected lookup');
  });

  for (const identity of ['', '1', '1:2:3', '-1:2', '1:-2', '1.5:2', '1:2.5', ' 1:2', '1:2 ', '1e2:3']) {
    assert.equal(AccountsService.resolveIdentity(identity, lookup), null);
  }

  assert.equal(lookup.mock.callCount(), 0);
});

await test('account identities require an existing rider with the current auth version', () => {
  const rider = Schema.decodeUnknownSync(riderSchema)({
    player_id: 7,
    username: 'rider@example.test',
    first_name: 'Test',
    last_name: 'Rider',
    pass_hash: '$argon2id$test',
    role: 'rider',
    enabled: 1,
    revision: 1,
    auth_version: 3,
    password_change_required: 0,
    official_player_id: null,
    is_admin: 0,
  });

  const get = (id: number) => (id === rider.player_id ? rider : null);

  assert.equal(AccountsService.identityOf(rider), '7:3');
  assert.equal(AccountsService.resolveIdentity('7:3', get), rider);
  assert.equal(AccountsService.resolveIdentity('7:2', get), null);
  assert.equal(AccountsService.resolveIdentity('7:4', get), null);
  assert.equal(AccountsService.resolveIdentity('8:3', get), null);
});
