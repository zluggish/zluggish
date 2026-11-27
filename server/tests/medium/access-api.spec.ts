import { ManagementService } from '#src/services/management.service';
import { mediumWeb } from '#tests/medium/support';
import { ACCESS_PUBLIC_URL, ACCESS_WEB } from '#tests/support/access';
import { runtimeFixture } from '#tests/support/runtime';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { Schema } from 'effect';

const overview = Schema.Struct({
  configured: Schema.Boolean,
  groups: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      name: Schema.String,
      emails: Schema.Array(Schema.String),
      riders: Schema.Array(Schema.Int),
    }),
  ),
  seen: Schema.Array(Schema.Struct({ email: Schema.String, lastSeen: Schema.Int })),
  ownEmail: Schema.Array(Schema.Struct({ playerId: Schema.Int, email: Schema.String })),
  unreachable: Schema.Array(Schema.Int),
});

async function fixture(t: TestContext, configured = true) {
  const f = runtimeFixture(t, configured ? ACCESS_PUBLIC_URL : null, true, configured ? ACCESS_WEB : {});
  const service = f.effects.runSync(ManagementService);
  const owner = await f.effects.runPromise(
    service.setup({
      mode: 'new',
      key: f.effects.runSync(service.issueSetupKey())!,
      username: 'owner@example.com',
      first_name: 'Owen',
      last_name: 'Owner',
      password: 'test-password',
    }),
  );
  const rider = await f.accounts.create('Olle Berg', 'test-password');
  const admin = mediumWeb(f, owner);
  const web = mediumWeb(f, rider);

  const call = async (path: string, method = 'GET', data?: Record<string, string>, status = 200) => {
    const response = await admin.request(path, method, data);
    const body: unknown = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));

    return body;
  };

  return { ...f, owner, rider, admin, web, call };
}

await test('the access API needs an administrator', async (t) => {
  const f = await fixture(t);

  for (const [path, method] of [
    ['/api/manage/access', 'GET'],
    ['/api/manage/access/groups', 'POST'],
    ['/api/manage/access/groups/1', 'PATCH'],
    ['/api/manage/access/groups/1', 'DELETE'],
    ['/api/manage/access/groups/1/emails/anna%40example.com', 'PUT'],
    ['/api/manage/access/groups/1/emails/anna%40example.com', 'DELETE'],
    ['/api/manage/access/groups/1/riders/2', 'PUT'],
    ['/api/manage/access/groups/1/riders/2', 'DELETE'],
  ] as const) {
    const response = await f.web.request(
      path,
      method,
      method === 'POST' || method === 'PATCH' ? { name: 'x' } : undefined,
    );
    assert.equal(response.status, 403, `${method} ${path}`);
  }

  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM access_group').get()?.n, 0);
});

await test('an administrator creates, fills, renames and deletes a group', async (t) => {
  const f = await fixture(t);
  const empty = Schema.decodeUnknownSync(overview)(await f.call('/api/manage/access'));
  assert.equal(empty.configured, true);
  assert.deepEqual(empty.groups, []);
  assert.deepEqual(empty.unreachable, [f.rider.player_id]);
  assert.deepEqual(empty.ownEmail, [{ playerId: f.owner.player_id, email: 'owner@example.com' }]);

  const created = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Int }))(
    await f.call('/api/manage/access/groups', 'POST', { name: '  Berg family ' }, 201),
  );
  const group = `/api/manage/access/groups/${created.id}`;

  // Adding twice is harmless, and emails are stored trimmed and lowercased.
  await f.call(`${group}/emails/${encodeURIComponent(' Anna@Example.com ')}`, 'PUT');
  await f.call(`${group}/emails/anna%40example.com`, 'PUT');
  await f.call(`${group}/riders/${f.rider.player_id}`, 'PUT');
  const filled = Schema.decodeUnknownSync(overview)(await f.call(`${group}/riders/${f.rider.player_id}`, 'PUT'));
  assert.deepEqual(filled.groups, [
    { id: created.id, name: 'Berg family', emails: ['anna@example.com'], riders: [f.rider.player_id] },
  ]);
  assert.deepEqual(filled.unreachable, []);

  const renamed = Schema.decodeUnknownSync(overview)(await f.call(group, 'PATCH', { name: 'Bergs' }));
  assert.equal(renamed.groups[0]?.name, 'Bergs');

  await f.call(`${group}/emails/anna%40example.com`, 'DELETE');
  await f.call(`${group}/emails/anna%40example.com`, 'DELETE');
  const removed = Schema.decodeUnknownSync(overview)(await f.call(`${group}/riders/${f.rider.player_id}`, 'DELETE'));
  assert.deepEqual(removed.groups[0]?.emails, []);
  assert.deepEqual(removed.groups[0]?.riders, []);

  const deleted = Schema.decodeUnknownSync(overview)(await f.call(group, 'DELETE'));
  assert.deepEqual(deleted.groups, []);
});

await test('the access API rejects bad input and unknown groups or riders', async (t) => {
  const f = await fixture(t);
  const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Int }))(
    await f.call('/api/manage/access/groups', 'POST', { name: 'Berg family' }, 201),
  );

  const status = async (...args: Parameters<typeof f.admin.request>) => {
    const response = await f.admin.request(...args);

    return response.status;
  };

  assert.equal(await status('/api/manage/access/groups', 'POST', { name: ' '.repeat(3) }), 400);
  assert.equal(await status('/api/manage/access/groups', 'POST', { name: 'x', extra: 'y' }), 400);
  assert.equal(await status(`/api/manage/access/groups/${id}/emails/cf-unresolved`, 'PUT'), 400);
  assert.equal(await status('/api/manage/access/groups/999/emails/anna%40example.com', 'PUT'), 404);
  assert.equal(await status(`/api/manage/access/groups/${id}/riders/999`, 'PUT'), 404);
  assert.equal(await status('/api/manage/access/groups/999', 'PATCH', { name: 'x' }), 404);
  assert.equal(await status('/api/manage/access/groups/999', 'DELETE'), 404);
  assert.equal(await status('/api/manage/access/groups/abc', 'DELETE'), 400);
});

await test('the overview says when Access sign-in is not configured', async (t) => {
  const f = await fixture(t, false);
  assert.equal(Schema.decodeUnknownSync(overview)(await f.call('/api/manage/access')).configured, false);
});
