import type { LogLevel } from '#src/enum';
import type { ResolvedConfig } from '#src/config/index';
import { inspect } from 'node:util';

const recentEntryLimit = 200;
const recentEntrySize = 4096;

const levels = { NOTSET: 0, VERBOSE: 10, DEBUG: 10, INFO: 20, WARNING: 30, WARN: 30, ERROR: 40, CRITICAL: 50 };

type Level = LogLevel;

type LogValue =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | Error
  | Array<LogValue>
  | { [key: string]: LogValue };

type Serialized = string | number | boolean | null | undefined | Array<Serialized> | { [key: string]: Serialized };

type Fields = Record<string, LogValue>;

type Options = Partial<Pick<ResolvedConfig['logging'], 'level'>> & {
  sink?: (line: string, level: Level) => void;
  clock?: () => Date;
};

// Errors keep their message, stack and cause: an operator cannot fix a failure the log hides.
// Fields whose names suggest credentials are still redacted.
function safe(value: LogValue, seen = new WeakSet<object>(), depth = 0): Serialized {
  if (typeof value === 'string') {
    // eslint-disable-next-line no-control-regex
    return value.replaceAll(/[\u{0000}-\u{001F}\u{007F}]/gu, ' ').slice(0, 500);
  }

  if (typeof value === 'bigint') {
    return String(value);
  }

  if (value instanceof Error) {
    if (seen.has(value) || depth >= 4) {
      return '[truncated]';
    }
    seen.add(value);

    // SAFETY: a cause can be any thrown value; safe() checks its runtime type and drops what it does not know.
    return {
      type: value.name,
      message: safe(value.message),
      stack: value.stack === undefined ? undefined : multiline(value.stack),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      cause: value.cause === undefined ? undefined : safe(value.cause as LogValue, seen, depth + 1),
    };
  }

  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }

  if (typeof value !== 'object') {
    return undefined;
  }

  if (seen.has(value) || depth >= 4) {
    return '[truncated]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => safe(item, seen, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 30)
      .map(([key, item]) => [
        key,
        /password|secret|token|cookie|authorization|csrf|key|email|address|body|payload|url/i.test(key)
          ? '[redacted]'
          : safe(item, seen, depth + 1),
      ]),
  );
}

function multiline(value: string) {
  // eslint-disable-next-line no-control-regex
  return value.replaceAll(/[\u{0000}-\u{0008}\u{000B}-\u{001F}\u{007F}]/gu, ' ').slice(0, 10_000);
}

function fieldText(value: Serialized, includeStack: boolean, key = ''): string {
  if (value === undefined) {
    return '';
  }

  if (value !== null && typeof value === 'object') {
    const parts = Object.entries(value)
      .filter(([name]) => includeStack || name !== 'stack')
      .map(([name, field]) => {
        const label = /^[\w-]+$/.test(name) ? name : inspect(name);
        return fieldText(field, includeStack, key ? `${key}.${label}` : label);
      })
      .filter(Boolean);

    return parts.length > 0 ? parts.join(' ') : '';
  }

  const display =
    typeof value === 'string' && /^[\w./:@+\-[\]]+$/.test(value) ? value : inspect(value, { colors: false });

  return `${key}=${display}`;
}

export class LoggingRepository {
  constructor(
    private readonly options: Options = {},
    private readonly context: Fields = {},
    private readonly history: Array<string> = [],
  ) {}

  configure(options: Options) {
    Object.assign(this.options, options);
  }

  child(fields: Fields) {
    return new LoggingRepository(this.options, { ...this.context, ...fields }, this.history);
  }

  recentEntries() {
    return this.history.toReversed();
  }

  isLevelEnabled(level: Level) {
    return levels[this.options.level ?? 'INFO'] <= levels[level];
  }

  verbose = (event: string, message: string, fields?: Fields) => this.write('VERBOSE', event, message, fields);

  info = (event: string, message: string, fields?: Fields) => this.write('INFO', event, message, fields);

  warn = (event: string, message: string, fields?: Fields) => this.write('WARN', event, message, fields);

  error = (event: string, message: string, fields?: Fields) => this.write('ERROR', event, message, fields);

  critical = (event: string, message: string, fields?: Fields) => this.write('CRITICAL', event, message, fields);

  private sink(line: string, level: Level) {
    if (this.options.sink) {
      this.options.sink(line, level);
    } else if (level === 'WARN') {
      console.warn(line);
    } else if (levels[level] >= levels.ERROR) {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  private remember(line: string) {
    // Copy truncated strings so retaining a slice cannot keep a large original entry alive.
    const entry =
      line.length > recentEntrySize ? `${Buffer.from(line.slice(0, recentEntrySize)).toString()}… [truncated]` : line;

    this.history.push(entry);

    if (this.history.length > recentEntryLimit) {
      this.history.shift();
    }
  }

  private write(level: Level, event: string, message: string, fields: Fields = {}) {
    if (!this.isLevelEnabled(level)) {
      return;
    }

    try {
      const all = { ...this.context, ...fields };
      const data = safe(all);

      const timestamp = (this.options.clock?.() ?? new Date()).toISOString();
      const prefix = `${timestamp} ${level} ${safe(event)} ${safe(message)}`;
      const historyFields = fieldText(data, true);
      this.remember(historyFields ? `${prefix} ${historyFields}` : prefix);

      // Text logs print each error the way Node does, stack and causes on their own lines.
      const traces = Object.values(all)
        .filter((value) => value instanceof Error)
        .map((error) => `\n${multiline(inspect(error, { depth: 4 }))}`)
        .join('');

      const consoleFields = fieldText(data, false);
      this.sink(`${consoleFields ? `${prefix} ${consoleFields}` : prefix}${traces}`, level);
    } catch {
      // Logging must never interrupt a request, network callback, or shutdown.
    }
  }
}
