import { ManagementService } from '#src/services/management.service';
import { mediumWeb } from '#tests/medium/support';
import { GATEWAY_CA, storeGatewaySecret } from '#tests/support/gateway';
import { X509Certificate } from 'node:crypto';
import { runtimeFixture } from '#tests/support/runtime';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { Schema } from 'effect';

const overview = Schema.Struct({
  configured: Schema.Boolean,
  gateway: Schema.Struct({
    enabled: Schema.Boolean,
    secretCreatedAt: Schema.NullOr(Schema.Int),
    certificate: Schema.NullOr(Schema.Struct({ subject: Schema.String, notAfter: Schema.String })),
  }),
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
  const f = runtimeFixture(t);

  if (configured) {
    storeGatewaySecret(f);
  }
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
    ['/api/manage/access/gateway-secret', 'POST'],
    ['/api/manage/access/gateway-secret', 'DELETE'],
    ['/api/manage/access/gateway-certificate', 'PUT'],
    ['/api/manage/access/gateway-certificate', 'DELETE'],
  ] as const) {
    const response = await f.web.request(
      path,
      method,
      method === 'PATCH' || path.endsWith('/groups')
        ? { name: 'x' }
        : method === 'POST' || method === 'PUT'
          ? { certificate: 'AAAA' }
          : undefined,
    );
    assert.equal(response.status, 403, `${method} ${path}`);
  }

  assert.equal(f.accounts.db.prepare('SELECT count(*) AS n FROM access_group').get()?.n, 0);
  assert.equal(f.accounts.repositories.accessGroupsRepository.gateway().certificate, null);
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

await test('the overview says when the gateway is not configured', async (t) => {
  const f = await fixture(t, false);
  assert.equal(Schema.decodeUnknownSync(overview)(await f.call('/api/manage/access')).configured, false);
});

await test('the Gateway secret turns the check on, is shown once, then only replaced or removed', async (t) => {
  const f = await fixture(t, false);
  const before = Schema.decodeUnknownSync(overview)(await f.call('/api/manage/access'));
  assert.deepEqual(before.gateway, { enabled: false, secretCreatedAt: null, certificate: null });
  assert.equal(before.configured, false);

  const made = Schema.decodeUnknownSync(Schema.Struct({ secret: Schema.String, configured: Schema.Boolean }))(
    await f.call('/api/manage/access/gateway-secret', 'POST', {}, 201),
  );
  assert.match(made.secret, /^[\da-f]{64}$/);
  assert.equal(made.configured, true);

  // Reading the page afterwards never returns the secret.
  const response = await f.admin.request('/api/manage/access');
  const text = await response.text();
  assert.doesNotMatch(text, new RegExp(made.secret));
  const after = Schema.decodeUnknownSync(overview)(JSON.parse(text));
  assert.equal(after.gateway.enabled, true);
  assert.equal(typeof after.gateway.secretCreatedAt, 'number');

  const again = Schema.decodeUnknownSync(Schema.Struct({ secret: Schema.String }))(
    await f.call('/api/manage/access/gateway-secret', 'POST', {}, 201),
  );
  assert.notEqual(again.secret, made.secret);

  const removed = Schema.decodeUnknownSync(overview)(await f.call('/api/manage/access/gateway-secret', 'DELETE'));
  assert.deepEqual(removed.gateway, { enabled: false, secretCreatedAt: null, certificate: null });
  assert.equal(removed.configured, false);
});

await test('the Gateway certificate is kept as PEM from PEM or DER, and only a CA certificate is accepted', async (t) => {
  const f = await fixture(t);
  const upload = (bytes: Uint8Array | string, status = 200) =>
    f.call(
      '/api/manage/access/gateway-certificate',
      'PUT',
      { certificate: Buffer.from(bytes).toString('base64') },
      status,
    );

  await upload('not a certificate', 400);
  await upload(f.accounts.repositories.cryptoRepository.randomBytes(64), 400);

  const fromDer = Schema.decodeUnknownSync(overview)(await upload(new X509Certificate(GATEWAY_CA).raw));
  assert.equal(fromDer.gateway.certificate?.subject, 'CN=Test Gateway CA');
  assert.equal(f.accounts.repositories.accessGroupsRepository.gateway().certificate, GATEWAY_CA);
  await upload(GATEWAY_CA);
  assert.equal(f.accounts.repositories.accessGroupsRepository.gateway().certificate, GATEWAY_CA);

  const removed = Schema.decodeUnknownSync(overview)(await f.call('/api/manage/access/gateway-certificate', 'DELETE'));
  assert.equal(removed.gateway.certificate, null);
});
