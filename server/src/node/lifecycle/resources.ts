type Closing = { status: 'closing'; promise: Promise<void> };

/** A runtime owns acquired resources in reverse order. Close is shared/idempotent;
one failed disposer must not prevent later disposers, especially the storage lock.
*/
export class Resources {
  private state: Closing | { status: 'open' | 'closed' } = { status: 'open' };
  private readonly disposers: (() => void | Promise<void>)[] = [];

  get status() {
    return this.state.status;
  }

  defer(dispose: () => void | Promise<void>) {
    if (this.state.status !== 'open') throw new Error('Resource owner is closing');
    this.disposers.push(dispose);
  }

  close() {
    if (this.state.status === 'closing') return this.state.promise;

    if (this.state.status === 'closed') return Promise.resolve();
    // Schedule effects after installing closing state, including reentrant close.
    // eslint-disable-next-line unicorn/prefer-promise-try -- Install closing state before invoking any disposer.
    const promise = Promise.resolve().then(() => this.dispose());
    this.state = { status: 'closing', promise };

    return promise;
  }

  private async dispose() {
    const errors: Error[] = [];

    for (const dispose of this.disposers.toReversed()) {
      try {
        await dispose();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error('Resource cleanup failed'));
      }
    }

    this.disposers.length = 0;
    this.state = { status: 'closed' };

    if (errors.length > 0) throw new AggregateError(errors, 'Resource cleanup failed');
  }
}
