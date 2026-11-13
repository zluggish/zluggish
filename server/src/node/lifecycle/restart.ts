const defaultOptions = { minutes: 10, intervalMs: 60_000, graceMs: 6000 };

export class RestartScheduler {
  private minutes = 0;
  private interval: NodeJS.Timeout | null = null;
  private final: NodeJS.Timeout | null = null;

  constructor(
    readonly announce: (message: string) => void,
    readonly stop: () => void,
    readonly options = defaultOptions,
  ) {}

  get active() {
    return this.interval !== null || this.final !== null;
  }

  start() {
    if (this.active) return false;
    this.minutes = this.options.minutes;
    this.tick();
    this.interval = setInterval(() => this.tick(), this.options.intervalMs);
    this.interval.unref();

    return true;
  }

  cancel() {
    if (!this.active) return false;
    this.clear();
    this.announce('Restart of the server has been cancelled. Ride on!');

    return true;
  }

  private clear() {
    if (this.interval) clearInterval(this.interval);

    if (this.final) clearTimeout(this.final);
    this.interval = null;
    this.final = null;
  }

  private tick() {
    if (this.minutes > 0) {
      this.announce(
        `Restarting / Shutting down in ${this.minutes} minutes. Save your progress or continue riding until server is back online`,
      );
      this.minutes -= 1;

      return;
    }

    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.announce('See you later! Look for the back online message.');
    this.final = setTimeout(() => {
      this.final = null;
      this.stop();
    }, this.options.graceMs);
    this.final.unref();
  }
}
