import { t } from '#src/i18n/index';
import { Cause, Effect, Exit, Scope } from 'effect';

type Closing = { status: 'closing'; promise: Promise<void> };

/** The errors behind a failed release: each release that failed or threw. */
function releaseErrors(cause: Cause.Cause<unknown>) {
  return cause.reasons.map((reason) => {
    const error = Cause.isDieReason(reason) ? reason.defect : Cause.isFailReason(reason) ? reason.error : reason;

    return error instanceof Error ? error : new Error(t('resource_cleanup_failed'));
  });
}

/** A runtime owns acquired resources in an Effect scope, released in reverse order. Close is shared
and idempotent; one failed release does not prevent later ones, especially the storage lock.
*/
export class Resources {
  /** Effects acquire into this scope; closing the owner releases them with the deferred ones. */
  readonly scope = Effect.runSync(Scope.make());

  private state: Closing | { status: 'open' | 'closed' } = { status: 'open' };

  get status() {
    return this.state.status;
  }

  defer(dispose: () => void | Promise<void>) {
    if (this.state.status !== 'open') {
      throw new Error(t('resource_owner_closing'));
    }
    Effect.runSync(
      Scope.addFinalizer(
        this.scope,
        Effect.promise(async () => {
          await dispose();
        }),
      ),
    );
  }

  close() {
    if (this.state.status === 'closing') {
      return this.state.promise;
    }

    if (this.state.status === 'closed') {
      return Promise.resolve();
    }

    // Install the closing state before any release runs, including a reentrant close.
    // eslint-disable-next-line unicorn/prefer-promise-try -- Install closing state before running any release.
    const promise = Promise.resolve()
      .then(() => Effect.runPromise(Effect.exit(Scope.close(this.scope, Exit.void))))
      .then((exit) => {
        this.state = { status: 'closed' };

        if (Exit.isFailure(exit)) {
          throw new AggregateError(releaseErrors(exit.cause), t('resource_cleanup_failed'));
        }
      });

    this.state = { status: 'closing', promise };

    return promise;
  }
}
