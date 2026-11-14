const defaultOptions = { minutes: 10, intervalMs: 60_000, graceMs: 6000 };

type Countdown = { status: 'countdown'; minutes: number; timer: NodeJS.Timeout };

type Grace = { status: 'grace'; timer: NodeJS.Timeout };

type Restart = Countdown | Grace | { status: 'idle' | 'fired' };

/** idle/fired -> countdown -> grace -> fired; cancel returns any active state to idle.
Each callback captures its generation, so cancelled timers cannot stop a later run.
*/
export class RestartScheduler {
  private state: Restart = { status: 'idle' };

  constructor(
    readonly announce: (message: string) => void,
    readonly stop: () => void,
    readonly options = defaultOptions,
  ) {}

  get active() {
    return this.state.status === 'countdown' || this.state.status === 'grace';
  }

  start() {
    if (this.active) return false;

    const countdown: Countdown = {
      status: 'countdown',
      minutes: this.options.minutes,
      timer: setInterval(() => this.tick(countdown), this.options.intervalMs),
    };

    countdown.timer.unref();
    this.state = countdown;
    this.tick(countdown);

    return true;
  }

  cancel() {
    if (this.state.status !== 'countdown' && this.state.status !== 'grace') return false;

    if (this.state.status === 'countdown') clearInterval(this.state.timer);
    else clearTimeout(this.state.timer);
    this.state = { status: 'idle' };
    this.announce('Restart of the server has been cancelled. Ride on!');

    return true;
  }

  private tick(countdown: Countdown) {
    if (this.state !== countdown) return;

    if (countdown.minutes > 0) {
      this.announce(
        `Restarting / Shutting down in ${countdown.minutes} minutes. Save your progress or continue riding until server is back online`,
      );
      countdown.minutes -= 1;

      return;
    }

    clearInterval(countdown.timer);
    this.announce('See you later! Look for the back online message.');

    if (this.state !== countdown) return;

    const grace: Grace = {
      status: 'grace',
      timer: setTimeout(() => {
        if (this.state !== grace) return;
        this.state = { status: 'fired' };
        this.stop();
      }, this.options.graceMs),
    };

    grace.timer.unref();
    this.state = grace;
  }
}
