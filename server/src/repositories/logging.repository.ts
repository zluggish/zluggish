import type { LogLevel } from '#src/enum';
// Serialization is the logging boundary: runtime checks safely encode recursive values.
/* oxlint-disable anti-slop/no-runtime-typeof */
import type { ResolvedConfig } from '#src/config/index';

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
  | LogValue[]
  | { [key: string]: LogValue };

type Serialized = string | number | boolean | null | undefined | Serialized[] | { [key: string]: Serialized };

type Fields = Record<string, LogValue>;

type Options = Partial<Pick<ResolvedConfig['logging'], 'level' | 'format'>> & {
  sink?: (line: string, level: Level) => void;
  clock?: () => Date;
};

// Diagnostic messages are deliberately codes/types, never arbitrary exception text:
// provider errors often contain tokens, URLs, or response bodies.
function safe(value: LogValue, seen = new WeakSet<object>(), depth = 0): Serialized {
  // eslint-disable-next-line no-control-regex
  if (typeof value === 'string') return value.replaceAll(/[\u{0000}-\u{001F}\u{007F}]/gu, ' ').slice(0, 500);

  if (typeof value === 'bigint') return String(value);

  if (value instanceof Error) return { type: value.name };

  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;

  if (typeof value !== 'object') return undefined;

  if (seen.has(value) || depth >= 4) return '[truncated]';
  seen.add(value);

  if (Array.isArray(value)) return value.slice(0, 30).map((item) => safe(item, seen, depth + 1));

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 30)
      .map(([key, item]) => [
        key,
        /password|secret|token|cookie|authorization|csrf|key|email|address|body|payload|stack|url/i.test(key)
          ? '[redacted]'
          : safe(item, seen, depth + 1),
      ]),
  );
}

export class LoggingRepository {
  constructor(
    private readonly options: Options = {},
    private readonly context: Fields = {},
  ) {}

  configure(options: Options) {
    Object.assign(this.options, options);
  }

  child(fields: Fields) {
    return new LoggingRepository(this.options, { ...this.context, ...fields });
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
    if (this.options.sink) this.options.sink(line, level);
    else if (level === 'WARN') console.warn(line);
    else if (levels[level] >= levels.ERROR) console.error(line);
    else console.log(line);
  }

  private write(level: Level, event: string, message: string, fields: Fields = {}) {
    if (!this.isLevelEnabled(level)) return;

    try {
      const data = safe({ ...this.context, ...fields });

      const entry = {
        timestamp: (this.options.clock?.() ?? new Date()).toISOString(),
        level,
        event: safe(event),
        message: safe(message),
        fields: data,
      };

      this.sink(
        this.options.format === 'json'
          ? JSON.stringify(entry)
          : `${entry.timestamp} ${level} ${entry.event} ${entry.message} ${JSON.stringify(data)}`,
        level,
      );
    } catch {
      // Logging must never interrupt a request, network callback, or shutdown.
    }
  }
}
