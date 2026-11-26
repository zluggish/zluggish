import { t } from '#src/i18n/index';
import { Context, Effect, Fiber, Layer } from 'effect';
import type { JobType } from '#src/enum';
import { RuntimeContext } from '#src/context';
import { JobError } from '#src/errors';
import { RunningJob } from '#src/repositories/jobs.repository';
import type { Claim, JobPayload } from '#src/repositories/jobs.repository';
import { SystemFlag } from '#src/repositories/system-flag.repository';

export type JobHandler = {
  concurrency: number;
  attempts: number;
  timeoutMs: number;
  /** Runs to the end: a timeout, a lost lease or a stop aborts `job.signal` instead of interrupting. */
  run: (job: RunningJob) => Effect.Effect<void, unknown>;
};

const leaseMs = 30_000;

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const repositories = context.accounts.repositories;
  const jobs = repositories.jobsRepository;
  const handlers = new Map<JobType, JobHandler>();
  const active = new Map<JobType, number>();
  const running = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  let poller: Fiber.Fiber<unknown> | null = null;
  let status: 'idle' | 'running' | 'stopped' = 'idle';
  let kicked = false;

  const paused = (type: JobType) =>
    type === 'delivery' && repositories.systemFlagsRepository.get(SystemFlag.UploadPause) !== null;

  /** Poll soon, after the current transaction commits. Kicks in one turn share one poll. */
  function kick() {
    if (status !== 'running' || kicked) {
      return;
    }
    kicked = true;
    setImmediate(() => {
      kicked = false;
      try {
        poll();
      } catch (error) {
        context.world.lifecycle.log.warn('job.poll_failed', 'Background job poll failed', {
          error: error instanceof Error ? error : String(error),
        });
      }
    });
  }

  function poll() {
    if (status !== 'running') {
      return;
    }
    const ready = jobs.ready();

    for (const [type, handler] of handlers) {
      if (!ready.has(type) || paused(type)) {
        continue;
      }

      while ((active.get(type) ?? 0) < handler.concurrency) {
        const claim = jobs.claim(type, leaseMs);

        if (!claim) {
          break;
        }
        launch(claim, handler);
      }
    }
  }

  function launch(claim: Claim, handler: JobHandler) {
    active.set(claim.type, (active.get(claim.type) ?? 0) + 1);

    const run = execute(claim, handler).finally(() => {
      active.set(claim.type, (active.get(claim.type) ?? 1) - 1);
      running.delete(run);
      kick();
    });

    running.add(run);
  }

  async function execute(claim: Claim, handler: JobHandler) {
    const controller = new AbortController();
    controllers.add(controller);
    const job = new RunningJob(claim, controller.signal, jobs);
    let renewalFailure: JobError | undefined;

    // Renew while the handler runs. A failed renewal stops the handler: another claim
    // may own the job now.
    const renewal = setInterval(() => {
      if (renewalFailure) {
        return;
      }
      try {
        if (!jobs.renew(claim, leaseMs)) {
          controller.abort(new JobError({ code: 'lease_lost' }));
        }
      } catch (error) {
        renewalFailure = new JobError({ code: 'lease_renewal_failed' });
        controller.abort(renewalFailure);
        context.world.lifecycle.log.warn('job.renewal_failed', 'Background job lease renewal failed', {
          jobId: claim.id,
          type: claim.type,
          error: error instanceof Error ? error : String(error),
        });
      }
    }, leaseMs / 3);

    const timeout = setTimeout(() => controller.abort(new JobError({ code: 'timeout' })), handler.timeoutMs);

    try {
      await Effect.runPromise(handler.run(job));

      if (renewalFailure) {
        throw renewalFailure;
      }

      if (!job.done) {
        job.commit();
      }
    } catch (error) {
      const code = error instanceof JobError ? error.code : error instanceof Error ? error.name : 'error';
      const retry = !(error instanceof JobError) || error.retry;

      // A stop is not a failure: the job runs again after the next start.
      if (status === 'stopped') {
        jobs.retry(claim, code, 0);
      } else if (retry && claim.attempts < handler.attempts) {
        jobs.retry(claim, code, Math.min(3_600_000, 1000 * 4 ** claim.attempts));
      } else {
        jobs.fail(claim, code);
      }

      context.world.lifecycle.log.warn('job.failed', 'Background job failed', {
        jobId: claim.id,
        type: claim.type,
        attempts: claim.attempts,
        code,
        error: error instanceof Error ? error : String(error),
      });
    } finally {
      clearInterval(renewal);
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  }

  async function drainNow() {
    const before = status;
    status = 'running';

    try {
      for (;;) {
        poll();

        if (running.size === 0) {
          return;
        }
        await Promise.all(running);
      }
    } finally {
      if (status === 'running') {
        status = before;
      }
    }
  }

  jobs.notify = kick;

  return {
    register: Effect.fn('JobsService.register')(function* (type: JobType, handler: JobHandler) {
      handlers.set(type, handler);
    }),

    enqueue: Effect.fn('JobsService.enqueue')(function* (type: JobType, payload: JobPayload, delayMs: number = 0) {
      return jobs.enqueue(type, payload, delayMs);
    }),

    start: Effect.fn('JobsService.start')(function* (intervalMs: number = 1000) {
      if (status === 'stopped' || poller) {
        return;
      }
      status = 'running';
      poller = yield* Effect.sleep(intervalMs).pipe(
        Effect.andThen(Effect.sync(poll)),
        Effect.forever,
        Effect.forkDetach,
      );
      poll();
    }),

    busy: Effect.fn('JobsService.busy')(function* () {
      if (running.size > 0) {
        return true;
      }
      const ready = jobs.ready();

      return handlers.keys().some((type) => ready.has(type) && !paused(type));
    }),

    kick: Effect.fn('JobsService.kick')(function* () {
      kick();
    }),

    /** Run one claimed job now, outside the polling loop. */
    run: Effect.fn('JobsService.run')(function* (claim: Claim) {
      const handler = handlers.get(claim.type);

      if (!handler) {
        return yield* Effect.die(new Error(t('jobs_handler_missing')));
      }

      yield* Effect.promise(() => execute(claim, handler));
    }),

    /** Run every ready job until none is left. For tests and offline commands. */
    drain: Effect.fn('JobsService.drain')(function* () {
      yield* Effect.promise(drainNow);
    }),

    /** Stop polling, abort running handlers and wait for them to finish. */
    close: Effect.fn('JobsService.close')(function* () {
      status = 'stopped';

      if (poller) {
        yield* Fiber.interrupt(poller);
      }
      poller = null;

      for (const controller of controllers) {
        controller.abort(new JobError({ code: 'shutdown' }));
      }
      yield* Effect.promise(() => Promise.allSettled(running));
    }),
  };
});

/** In-process runner for the job table. One process owns the table; leases and claim
tokens fence handlers that outlive their lease.
*/
export class JobsService extends Context.Service<JobsService, Effect.Success<typeof make>>()('zluggish/JobsService') {
  static readonly layer = Layer.effect(JobsService, make);
}
