import { AccessGroupsService } from '#src/services/access-groups.service';
import { ACCESS_PUBLIC_URL, ACCESS_WEB } from '#tests/support/access';
import { runtimeFixture } from '#tests/support/runtime';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { test } from 'node:test';

async function fixture(t: TestContext) {
  const f = runtimeFixture(t, ACCESS_PUBLIC_URL, true, {}, ACCESS_WEB);
  const service = f.effects.runSync(AccessGroupsService);
  const anna = await f.accounts.create('Anna Berg', 'test-password', 'anna@example.com');
  const olle = await f.accounts.create('Olle Berg', 'test-password');
  const karl = await f.accounts.create('Karl Lund', 'test-password');
  const visitor = await f.accounts.create('Vera Visit', 'test-password');
  const run = <A>(effect: Parameters<typeof f.effects.runSync<A, never>>[0]) => f.effects.runSync(effect);
  const ids = (email: string) => service.riders(email).map((user) => user.player_id);

  return { ...f, service, anna, olle, karl, visitor, run, ids };
}

await test('riders(email) unions every group of an email and keeps riders who belong to several groups', async (t) => {
  const f = await fixture(t);
  const berg = f.run(f.service.create('Berg family')).id;
  const lund = f.run(f.service.create('Lund family')).id;
  f.run(f.service.addEmail(berg, 'anna@example.com'));
  f.run(f.service.addEmail(berg, 'johan@example.com'));
  f.run(f.service.addEmail(lund, 'lisa@example.com'));
  // Johan rides in both households.
  f.run(f.service.addEmail(lund, 'johan@example.com'));
  f.run(f.service.addRider(berg, f.olle.player_id));
  f.run(f.service.addRider(berg, f.visitor.player_id));
  f.run(f.service.addRider(lund, f.karl.player_id));
  f.run(f.service.addRider(lund, f.visitor.player_id));

  // Anna also sees herself through her username.
  assert.deepEqual(
    f.ids('anna@example.com').toSorted((a, b) => a - b),
    [f.anna.player_id, f.olle.player_id, f.visitor.player_id],
  );
  assert.deepEqual(
    f.ids('johan@example.com').toSorted((a, b) => a - b),
    [f.olle.player_id, f.karl.player_id, f.visitor.player_id],
  );
  assert.deepEqual(
    f.ids('lisa@example.com').toSorted((a, b) => a - b),
    [f.karl.player_id, f.visitor.player_id],
  );
  assert.deepEqual(f.ids('nobody@example.com'), []);
});

await test('riders(email) matches emails and usernames without case and hides disabled riders', async (t) => {
  const f = await fixture(t);
  const berg = f.run(f.service.create('Berg family')).id;
  f.run(f.service.addEmail(berg, 'johan@example.com'));
  f.run(f.service.addRider(berg, f.olle.player_id));

  assert.deepEqual(f.ids('  Johan@Example.COM '), [f.olle.player_id]);
  assert.deepEqual(f.ids('ANNA@example.com'), [f.anna.player_id]);
  // A placeholder username is not an email anybody signs in with.
  assert.deepEqual(f.ids(f.olle.username), []);

  f.accounts.db.prepare('UPDATE user SET enabled=0 WHERE player_id IN (?, ?)').run(f.olle.player_id, f.anna.player_id);
  assert.deepEqual(f.ids('johan@example.com'), []);
  assert.deepEqual(f.ids('anna@example.com'), []);
});

await test('deleting a group or a rider removes their memberships', async (t) => {
  const f = await fixture(t);
  const berg = f.run(f.service.create('Berg family')).id;
  f.run(f.service.addEmail(berg, 'johan@example.com'));
  f.run(f.service.addRider(berg, f.olle.player_id));
  f.run(f.service.addRider(berg, f.karl.player_id));

  f.accounts.db.prepare('DELETE FROM user WHERE player_id=?').run(f.karl.player_id);
  assert.deepEqual(f.ids('johan@example.com'), [f.olle.player_id]);
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM access_group_rider').get()?.n, 1);

  f.run(f.service.remove(berg));
  assert.deepEqual(f.ids('johan@example.com'), []);
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM access_group_rider').get()?.n, 0);
  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM access_group_email').get()?.n, 0);
});

await test('the overview sorts riders into groups, their own email and unreachable', async (t) => {
  const f = await fixture(t);
  const berg = f.run(f.service.create('Berg family')).id;
  f.run(f.service.addRider(berg, f.olle.player_id));
  f.run(f.service.recordSeen('Lisa@Example.com'));
  f.run(f.service.recordSeen('anna@example.com'));

  const overview = f.run(f.service.overview());
  assert.equal(overview.configured, true);
  assert.deepEqual(overview.groups, [{ id: berg, name: 'Berg family', emails: [], riders: [f.olle.player_id] }]);
  assert.deepEqual(overview.ownEmail, [{ playerId: f.anna.player_id, email: 'anna@example.com' }]);
  assert.deepEqual(
    overview.unreachable.toSorted((a, b) => a - b),
    [f.karl.player_id, f.visitor.player_id],
  );
  // Anna already has a rider, so only Lisa waits for a group.
  assert.deepEqual(
    overview.seen.map((row) => row.email),
    ['lisa@example.com'],
  );

  f.run(f.service.addEmail(berg, 'lisa@example.com'));
  assert.deepEqual(f.run(f.service.overview()).seen, []);
});

await test('only the 50 most recent unmatched emails are kept', async (t) => {
  const f = await fixture(t);
  const now = Date.now();

  for (let i = 0; i < 55; i++) {
    f.accounts.repositories.accessGroupsRepository.recordSeen(`rider${i}@example.com`, now + i);
  }

  const seen = f.accounts.repositories.accessGroupsRepository.seen();
  assert.equal(seen.length, 50);
  assert.equal(seen[0]?.email, 'rider54@example.com');
  assert.equal(seen.at(-1)?.email, 'rider5@example.com');
});

await test('launcher identity is off until Access sign-in is configured', async (t) => {
  const off = runtimeFixture(t);
  assert.equal(off.config.network.web.cloudflareAccess, null);
  assert.equal(off.effects.runSync(AccessGroupsService).identify(undefined), 'off');

  const f = await fixture(t);
  assert.equal(f.service.identify(undefined), 'unidentified');
  assert.deepEqual(f.service.identify(f.service.deviceToken('Anna@Example.com')), { email: 'anna@example.com' });
});
