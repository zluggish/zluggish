import type { LoggingRepository } from '#src/repositories/logging.repository';
import { performance } from 'node:perf_hooks';

/** The last few non-empty lines of a tool's output: enough to see what it did without flooding the log. */
function tail(output: string, lines = 6) {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-lines)
    .join('\n');
}

const since = (from: number) => Math.round(performance.now() - from);

/** INFO lines for one app build: when it starts, each step with how long the one before took, each external tool
run, and how it ended. Patching an app runs Java tools on files from outside, so the log is how a failure is traced.
*/
export class BuildLog {
  private startedAt = 0;

  private stepStartedAt = 0;

  private current: string | null = null;

  constructor(
    private readonly log: LoggingRepository,
    private readonly prefix: string,
    private readonly app: string,
  ) {}

  started(kind: string, steps: ReadonlyArray<string>) {
    this.startedAt = performance.now();
    this.stepStartedAt = this.startedAt;
    this.current = steps[0] ?? null;
    this.log.info(`${this.prefix}.job_started`, `Started a ${this.app} ${kind} job`, {
      kind,
      steps: steps.join(', '),
      step: this.current,
    });
  }

  step(next: string) {
    if (next === this.current) {
      return;
    }
    this.log.info(`${this.prefix}.job_step`, `${this.app} job: ${next}`, {
      step: next,
      previous: this.current,
      previousMs: since(this.stepStartedAt),
    });
    this.current = next;
    this.stepStartedAt = performance.now();
  }

  finished(failure?: string) {
    const fields = { step: this.current, stepMs: since(this.stepStartedAt), durationMs: since(this.startedAt) };

    if (failure === undefined) {
      this.log.info(`${this.prefix}.job_done`, `Finished the ${this.app} job`, fields);
    } else {
      this.log.warn(`${this.prefix}.job_failed`, `The ${this.app} job stopped`, { ...fields, error: failure });
    }
    this.current = null;
  }

  /** A fact found along the way, such as what an upload holds or which Java runs the tools. */
  info(event: string, message: string, fields: Parameters<LoggingRepository['info']>[2]) {
    this.log.info(`${this.prefix}.${event}`, message, fields);
  }

  /** Run an external tool, logging its arguments, how long it took and the end of its output. */
  async tool(name: string, args: ReadonlyArray<string>, run: () => Promise<string>) {
    const begun = performance.now();
    this.log.info(`${this.prefix}.tool_started`, `Running ${name}`, { tool: name, args: args.join(' ') });

    try {
      const output = await run();
      this.log.info(`${this.prefix}.tool_done`, `${name} finished`, {
        tool: name,
        durationMs: since(begun),
        output: tail(output),
      });

      return output;
    } catch (error) {
      this.log.warn(`${this.prefix}.tool_failed`, `${name} failed`, {
        tool: name,
        durationMs: since(begun),
        error: error instanceof Error ? error : String(error),
      });
      throw error;
    }
  }
}
