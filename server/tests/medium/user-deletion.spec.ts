import { Effect } from 'effect';
import { create } from '@bufbuild/protobuf';
import { ActivitiesService } from '#src/services/activities.service';
import { JobsService } from '#src/services/jobs.service';
import { ManagementService } from '#src/services/management.service';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { worldTime } from '#src/world/state';
import { createWebApp } from '#src/http/web-app';
import { runtimeFixture } from '#tests/support/runtime';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

async function administrator(t: TestContext) {
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
  const opened = Effect.runSync(service.sessions.create(f.accounts.identityOf(owner), Date.now() + 900_000));

  const rider = await f.effects.runPromise(
    service.create(
      opened.id,
      { username: 'leaving@example.com', first_name: 'Leaving', last_name: 'Rider', password: 'test-password' },
      crypto.randomUUID(),
    ),
  );

  return { f, service, owner, session: opened.id, rider: f.accounts.get(rider.player_id)! };
}

function count(f: ReturnType<typeof runtimeFixture>, table: string, column = 'player_id', value: number) {
  return Number(f.accounts.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get(value)?.n);
}

await test('deleting a user removes the account, its rows and folder, and retires the player ID', async (t) => {
  const { f, service, session, rider } = await administrator(t);
  const db = f.accounts.db;
  const id = rider.player_id;

  const activity = Number(
    db
      .prepare(
        'INSERT INTO activity (player_id, start_date, distanceInMeters, movingTimeInMs) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
      )
      .run(id, '2026-03-01T08:00:00Z', 20_000, 3_600_000, id, '2026-05-01T08:00:00Z', 5500, 900_000).lastInsertRowid,
  );
  db.prepare('INSERT INTO activity_file (activity_id, full) VALUES (?, 0)').run(activity);
  db.prepare('INSERT INTO activity_image (player_id, activity_id) VALUES (?, ?)').run(id, activity);
  db.prepare("INSERT INTO goal (player_id, name) VALUES (?, 'Weekly')").run(id);
  db.prepare("INSERT INTO rider_settings (player_id, value) VALUES (?, '{}')").run(id);
  db.prepare("INSERT INTO rider_document (player_id, name, data) VALUES (?, 'strava_token.txt', x'00')").run(id);
  db.prepare("INSERT INTO access_group (id, name) VALUES (1, 'Club')").run();
  db.prepare('INSERT INTO access_group_rider (group_id, player_id) VALUES (1, ?)').run(id);
  const folder = f.profiles.folder(id);
  mkdirSync(resolve(folder, 'activities'), { recursive: true });
  writeFileSync(resolve(folder, 'avatarLarge.jpg'), Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]));
  const riderSession = Effect.runSync(service.sessions.create(f.accounts.identityOf(rider)));

  const footprint = f.effects.runSync(service.footprint(session, id));
  assert.equal(footprint.activities, 2);
  assert.equal(footprint.distance_m, 25_500);
  assert.equal(footprint.moving_ms, 4_500_000);
  assert.equal(footprint.first_ride, '2026-03-01T08:00:00Z');
  assert.equal(footprint.last_ride, '2026-05-01T08:00:00Z');
  assert.equal(footprint.connected, false);

  const input = { revision: rider.revision, operation: crypto.randomUUID(), username: ' Leaving@Example.com ' };
  const deleted = f.effects.runSync(service.remove(session, id, input));
  assert.deepEqual(deleted, { player_id: id, username: 'leaving@example.com' });
  // A lost response is retried with the same operation and gets the same answer.
  assert.deepEqual(f.effects.runSync(service.remove(session, id, input)), deleted);

  assert.equal(f.accounts.get(id), null);
  assert.equal(Effect.runSync(service.sessions.user(riderSession.id)), null);

  for (const table of [
    'activity',
    'activity_image',
    'goal',
    'rider_settings',
    'rider_document',
    'access_group_rider',
    'web_session',
  ]) {
    const n =
      table === 'web_session'
        ? Number(db.prepare("SELECT count(*) AS n FROM web_session WHERE identity LIKE ? || ':%'").get(String(id))?.n)
        : count(f, table, 'player_id', id);
    assert.equal(n, 0, table);
  }
  assert.equal(count(f, 'activity_file', 'activity_id', activity), 0);

  f.effects.runSync(ActivitiesService);
  await f.effects.runPromise(JobsService.use((jobs) => jobs.drain()));
  assert.equal(existsSync(folder), false);

  const next = await f.effects.runPromise(
    service.create(
      session,
      { username: 'new@example.com', first_name: 'New', last_name: 'Rider', password: 'test-password' },
      crypto.randomUUID(),
    ),
  );
  assert.ok(next.player_id > id, 'a deleted player ID is not reused');
  const offline = await f.accounts.create('Offline Rider', 'test-password');
  assert.ok(offline.player_id > id);
});

await test('deleting a user is refused for yourself, a wrong name, a stale revision or a rider in the game', async (t) => {
  const { f, service, owner, session, rider } = await administrator(t);
  const attempt = (target: number, values: Partial<{ revision: number; username: string }> = {}) =>
    f.effects.runSync(
      service.remove(session, target, {
        revision: rider.revision,
        operation: crypto.randomUUID(),
        username: rider.username,
        ...values,
      }),
    );

  assert.throws(() => attempt(owner.player_id, { revision: owner.revision, username: owner.username }), /own account/);
  assert.throws(() => attempt(rider.player_id, { username: 'someone-else' }), /does not match/);
  assert.throws(() => attempt(rider.player_id, { revision: rider.revision + 1 }), /changed/);

  f.world.login(BigInt(rider.player_id), Buffer.alloc(16, 1));
  f.world.online.set(
    BigInt(rider.player_id),
    create(PlayerStateSchema, { id: BigInt(rider.player_id), worldTime: worldTime() }),
  );
  assert.equal(f.effects.runSync(service.footprint(session, rider.player_id)).connected, true);
  assert.throws(() => attempt(rider.player_id), /riding/);
  assert.ok(f.accounts.get(rider.player_id));
});

await test('only administrators reach the delete route', async (t) => {
  const { f, service, rider } = await administrator(t);
  const web = createWebApp(f);
  const other = await f.effects.runPromise(
    service.create(
      Effect.runSync(
        service.sessions.create(f.accounts.identityOf(f.accounts.byUsername('owner')!), Date.now() + 900_000),
      ).id,
      { username: 'plain@example.com', first_name: 'Plain', last_name: 'Rider', password: 'test-password' },
      crypto.randomUUID(),
    ),
  );
  const plain = Effect.runSync(service.sessions.create(f.accounts.identityOf(f.accounts.get(other.player_id)!)));
  const owner = Effect.runSync(
    service.sessions.create(f.accounts.identityOf(f.accounts.byUsername('owner')!), Date.now() + 900_000),
  );

  const request = (opened: typeof plain) =>
    web.request(`http://local:8080/api/manage/users/${rider.player_id}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `zluggish_web_session=${opened.id}`,
        'X-CSRF-Token': opened.session.csrf,
        Origin: 'http://local:8080',
      },
      body: JSON.stringify({ revision: rider.revision, operation: crypto.randomUUID(), username: rider.username }),
    });

  const refused = await request(plain);
  assert.equal(refused.status, 403);
  assert.ok(f.accounts.get(rider.player_id));
  const accepted = await request(owner);
  assert.equal(accepted.status, 200);
  assert.equal(f.accounts.get(rider.player_id), null);
});
