import { ActivitiesService } from '#src/services/activities.service';
import { RuntimeContext } from '#src/context';
import { DocumentsService } from '#src/services/documents.service';
import { immediate } from '#src/db/transaction';
import { JobError } from '#src/errors';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { JobsRepository } from '#src/repositories/jobs.repository';
import { JobsService } from '#src/services/jobs.service';
import { UploadsService } from '#src/services/uploads.service';
import { binary, mediumFixture } from '#tests/medium/support';
import { create } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Effect, Layer, Schema } from 'effect';

function jobRunner(f: Awaited<ReturnType<typeof mediumFixture>>) {
  return Effect.runSync(
    Effect.gen(function* () {
      return yield* JobsService;
    }).pipe(Effect.provide(JobsService.layer), Effect.provide(Layer.succeed(RuntimeContext, f))),
  );
}

const fit = readFileSync(new URL('../fixtures/ride.fit', import.meta.url));

async function completed(f: Awaited<ReturnType<typeof mediumFixture>>) {
  const data = {
    playerId: BigInt(f.rider.player_id),
    courseId: 6n,
    name: 'Ride',
    startDate: new Date().toISOString(),
    distanceInMeters: 3000,
    fitFilename: 'ride.fit',
    fit,
  };

  const response = await f.request(`/api/profiles/${f.rider.player_id}/activities`, {
    method: 'POST',
    ...binary(ActivitySchema, data),
  });

  const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(await response.json());
  f.effects.runSync(
    ActivitiesService.use((service) => service.finalize(create(ActivitySchema, { ...data, id: BigInt(id) }))),
  );

  return id;
}

await test('a rollback creates neither the change nor the job', async (t) => {
  const f = await mediumFixture(t);

  assert.throws(() =>
    immediate(f.accounts.db, () => {
      f.accounts.db.prepare("UPDATE user SET first_name='Changed' WHERE player_id=?").run(f.rider.player_id);
      f.accounts.repositories.jobsRepository.enqueue('retention', { player: f.rider.player_id });
      throw new Error('abort');
    }),
  );

  assert.equal(f.accounts.get(f.rider.player_id)?.first_name, 'Medium');
  assert.equal(f.accounts.repositories.jobsRepository.list().length, 0);
});

await test('a stopped process does not lose its job; a new claim runs it after the lease', async (t) => {
  const f = await mediumFixture(t);
  let now = 1_000_000;
  const jobs = new JobsRepository(f.accounts.db, () => now);
  jobs.enqueue('retention', {});
  const first = jobs.claim('retention', 30_000);
  assert.ok(first);
  assert.equal(jobs.claim('retention', 30_000), null, 'a valid lease blocks another claim');
  now += 30_000;
  const second = jobs.claim('retention', 30_000);
  assert.ok(second);
  assert.equal(second.attempts, 2);
  assert.equal(jobs.finish(second), true);
  assert.equal(jobs.list()[0]?.state, 'done');
});

await test('an old handler after lease expiry and a new claim cannot commit or publish', async (t) => {
  const f = await mediumFixture(t);
  let now = 1_000_000;
  const jobs = new JobsRepository(f.accounts.db, () => now);
  jobs.enqueue('retention', {});
  const old = jobs.claim('retention', 30_000);
  assert.ok(old);
  now += 31_000;
  assert.equal(jobs.renew(old, 30_000), false, 'renewal fails after expiry');
  const current = jobs.claim('retention', 30_000);
  assert.ok(current);
  let committed = 0;
  assert.equal(
    jobs.finish(old, () => committed++),
    false,
  );
  assert.equal(committed, 0);
  assert.equal(
    jobs.finish(current, () => committed++),
    true,
  );
  assert.equal(committed, 1);

  // File results: an old claim's attempt-specific file is never published.
  const id = await completed(f);
  const export_ = resolve(f.profiles.folder(f.rider.player_id), 'fit', `${id} - ride.fit`);
  await f.effects.runPromise(JobsService.use((service) => service.drain()));
  rmSync(export_);
  const repository = f.accounts.repositories.jobsRepository;
  repository.enqueue('fit_export', { activityId: id });
  const stale = repository.claim('fit_export', 1);
  assert.ok(stale);
  await new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
  assert.equal(repository.valid(stale), false);
  await f.effects.runPromise(JobsService.use((service) => service.run(stale)));
  assert.equal(existsSync(export_), false);
  assert.equal(
    readdirSync(resolve(export_, '..')).some((name) => name.endsWith('.tmp')),
    false,
  );
});

await test('a delivery lease expiry does not authorize a second send', async (t) => {
  const f = await mediumFixture(t);
  f.effects.runSync(DocumentsService.use((service) => service.put(f.rider.player_id, 'runalyze_token.txt', 'token')));
  const id = await completed(f);
  const repository = f.accounts.repositories.jobsRepository;
  const gate = Promise.withResolvers<Response>();
  const sent = Promise.withResolvers<void>();

  const sends = t.mock.method(globalThis, 'fetch', () => {
    sent.resolve();

    return gate.promise;
  });

  const jobs = jobRunner(f);
  f.effects.runSync(UploadsService.use((uploads) => uploads.registerJobs(jobs)));

  const first = repository.claim('delivery', 50);
  assert.ok(first);
  const sending = Effect.runPromise(jobs.run(first));

  // The send follows a durable flush, which can take more than one tick on slow file systems.
  await sent.promise;
  assert.equal(sends.mock.callCount(), 1);
  assert.equal(
    f.effects.runSync(UploadsService.use((service) => service.status(f.rider.player_id)))[0]?.state,
    'sending',
  );

  // The lease expires during the request: a replacement claim must not send again.
  await new Promise((resolve) => {
    setTimeout(resolve, 60);
  });
  const second = repository.claim('delivery', 30_000);
  assert.ok(second);
  await Effect.runPromise(jobs.run(second));
  assert.equal(sends.mock.callCount(), 1);
  assert.equal(
    f.effects.runSync(UploadsService.use((service) => service.status(f.rider.player_id)))[0]?.state,
    'ambiguous',
  );

  // The first attempt then learns the provider accepted it: that result is recorded.
  gate.resolve(new Response(null, { status: 200 }));
  await sending;
  assert.equal(f.effects.runSync(UploadsService.use((service) => service.status(f.rider.player_id)))[0]?.state, 'sent');
  assert.equal(sends.mock.callCount(), 1);
  assert.equal(id > 0, true);
});

await test('a job that exceeds its time limit is stopped, retried, then failed after its attempts', async (t) => {
  const f = await mediumFixture(t);
  const jobs = jobRunner(f);
  const repository = f.accounts.repositories.jobsRepository;
  let runs = 0;

  Effect.runSync(
    jobs.register('retention', {
      concurrency: 1,
      attempts: 2,
      timeoutMs: 20,
      run: (job) => {
        runs++;

        return Effect.promise(
          () =>
            new Promise((_resolve, reject) => {
              job.signal.addEventListener('abort', () =>
                reject(Schema.decodeUnknownSync(Schema.instanceOf(Error))(job.signal.reason)),
              );
            }),
        );
      },
    }),
  );
  repository.enqueue('retention', {});

  const first = repository.claim('retention', 30_000);
  assert.ok(first);
  await Effect.runPromise(jobs.run(first));
  assert.deepEqual(
    repository.list().map((job) => [job.state, job.last_error, job.attempts]),
    [['queued', 'timeout', 1]],
  );

  f.accounts.db.exec('UPDATE job SET next_run_at=0');
  const second = repository.claim('retention', 30_000);
  assert.ok(second);
  await Effect.runPromise(jobs.run(second));
  assert.deepEqual(
    repository.list().map((job) => [job.state, job.last_error, job.attempts]),
    [['failed', 'timeout', 2]],
  );
  assert.equal(runs, 2);
});

await test('a job that cannot succeed fails at once, and each type runs at most its concurrency', async (t) => {
  const f = await mediumFixture(t);
  const jobs = jobRunner(f);
  const repository = f.accounts.repositories.jobsRepository;
  let running = 0;
  let peak = 0;

  Effect.runSync(
    jobs.register('chart', {
      concurrency: 2,
      attempts: 5,
      timeoutMs: 10_000,
      run: () =>
        Effect.promise(async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((resolve) => {
            setTimeout(resolve, 10);
          });
          running--;
        }),
    }),
  );

  for (let index = 0; index < 6; index++) {
    repository.enqueue('chart', { index });
  }
  await Effect.runPromise(jobs.drain());
  assert.equal(peak, 2);
  assert.ok(repository.list('chart').every((job) => job.state === 'done'));

  Effect.runSync(
    jobs.register('power_curve', {
      concurrency: 1,
      attempts: 5,
      timeoutMs: 10_000,
      run: () => Effect.fail(new JobError({ code: 'invalid_payload', retry: false })),
    }),
  );
  repository.enqueue('power_curve', {});
  await Effect.runPromise(jobs.drain());
  assert.deepEqual(
    repository.list('power_curve').map((job) => [job.state, job.attempts]),
    [['failed', 1]],
  );
});

for (const replaced of [false, true]) {
  await test(`a throwing lease renewal aborts and fences the job (replaced: ${replaced})`, async (t) => {
    const f = await mediumFixture(t);
    const jobs = jobRunner(f);
    const repository = f.accounts.repositories.jobsRepository;
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const warnings = t.mock.method(f.world.lifecycle.log, 'warn');
    const failure = new Error('injected renewal DB failure');
    const renew = t.mock.method(repository, 'renew', () => {
      throw failure;
    });
    t.mock.timers.enable({ apis: ['setInterval'] });

    Effect.runSync(
      jobs.register('retention', {
        concurrency: 1,
        attempts: 3,
        timeoutMs: 60_000,
        run: (job) =>
          Effect.promise(async () => {
            signal = job.signal;
            started.resolve();
            await finish.promise;
          }),
      }),
    );
    repository.enqueue('retention', {});
    const claim = repository.claim('retention', 30_000);
    assert.ok(claim);
    const running = Effect.runPromise(jobs.run(claim));
    await started.promise;
    t.mock.timers.tick(10_000);
    assert.equal(signal?.aborted, true);
    assert.ok(signal?.reason instanceof JobError);
    assert.equal(signal.reason.code, 'lease_renewal_failed');
    t.mock.timers.tick(10_000);
    assert.equal(renew.mock.callCount(), 1, 'an aborted job stops renewing');
    assert.ok(
      warnings.mock.calls.some(({ arguments: args }) => args[0] === 'job.renewal_failed' && args[2]?.error === failure),
    );

    if (replaced) {
      f.accounts.db.exec('UPDATE job SET lease_expires_at=0');
      const replacement = repository.claim('retention', 30_000);
      assert.ok(replacement);
      finish.resolve();
      await running;
      assert.equal(repository.valid(replacement), true, 'the old attempt cannot retry or finish the new claim');
      assert.equal(repository.finish(replacement), true);
    } else {
      finish.resolve();
      await running;
      const [row] = repository.list();
      assert.equal(row?.state, 'queued');
      assert.equal(row?.last_error, 'lease_renewal_failed');
      assert.ok(row && row.next_run_at > Date.now(), 'normal retry backoff is retained');
      assert.equal(repository.claim('retention', 30_000), null);
    }
    t.mock.timers.tick(30_000);
    assert.equal(renew.mock.callCount(), 1, 'cleanup removes the timer');
  });
}

await test('a kicked poll contains database errors and can poll again', async (t) => {
  const f = await mediumFixture(t);
  const jobs = jobRunner(f);
  const repository = f.accounts.repositories.jobsRepository;
  const warnings = t.mock.method(f.world.lifecycle.log, 'warn');
  Effect.runSync(jobs.start(60_000));
  const ready = t.mock.method(repository, 'ready', () => {
    throw new Error('injected poll DB failure');
  });
  Effect.runSync(jobs.kick());
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.ok(warnings.mock.calls.some(({ arguments: args }) => args[0] === 'job.poll_failed'));
  ready.mock.restore();
  Effect.runSync(jobs.kick());
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await Effect.runPromise(jobs.close());
});
