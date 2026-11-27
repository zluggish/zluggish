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
      stack: value.stack === undefined ? undefined : multiline(value.stack).slice(0, 10_000),
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

  return safeFields(value, seen, depth);
}

function safeFields(fields: Fields, seen: WeakSet<object>, depth: number): Record<string, Serialized> {
  return Object.fromEntries(
    Object.entries(fields)
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
  return value.replaceAll(/[\u{0000}-\u{0008}\u{000B}-\u{001F}\u{007F}]/gu, ' ');
}

function fieldText(value: Serialized, key = ''): string {
  if (value === undefined) {
    return '';
  }

  if (value !== null && typeof value === 'object') {
    const parts = Object.entries(value)
      .map(([name, field]) => {
        const label = /^[\w-]+$/.test(name) ? name : inspect(name);
        return fieldText(field, key ? `${key}.${label}` : label);
      })
      .filter(Boolean);

    return parts.length > 0 ? parts.join(' ') : '';
  }

  const display =
    typeof value === 'string' && /^[\w./:@+\-[\]]+$/.test(value) ? value : inspect(value, { colors: false });

  return `${key}=${display}`;
}

// Only these details accompany the message in the console. The admin viewer can inspect the full entry.
const consoleDetails: Record<string, string> = {
  playerId: 'rider #{}',
  activityId: 'activity #{}',
  jobId: 'job #{}',
  provider: '{}',
  app: '{}',
  version: 'v{}',
  versionName: 'v{}',
  java: 'Java {}',
  outcome: '{}',
  reason: '{}',
  distanceMeters: '{} m',
  elapsedSeconds: '{} s',
  durationMs: '{} ms',
  files: '{} files',
  bytes: '{} bytes',
  waiting: '{} waiting',
  count: '{} total',
  notAfter: 'expires {}',
  error: '{}',
};

function consoleMessage(event: string, message: string, fields: Record<string, Serialized>) {
  const { host, port, method, route, status, durationMs } = fields;

  if (event === 'server.ready' && typeof host === 'string' && typeof port === 'number') {
    return `Server ready on ${host.includes(':') ? `[${host}]` : host}:${port}`;
  }

  if (event === 'http.completed' && typeof method === 'string' && typeof route === 'string') {
    return `${method} ${route} → ${status} (${durationMs} ms)`;
  }

  const details: Array<string> = [];

  for (const [key, format] of Object.entries(consoleDetails)) {
    const value = fields[key];

    if (typeof value === 'number' || (typeof value === 'string' && value)) {
      details.push(format.replace('{}', () => String(value)));
    }
  }

  if (fields.counterReset === true) {
    details.push('distance counter reset');
  }

  if (typeof fields.suppressed === 'number' && fields.suppressed > 0) {
    details.push(`${fields.suppressed} repeats suppressed`);
  }

  return details.length > 0 ? `${message} (${details.join(', ')})` : message;
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

  warn = (event: string, message: string, fields?: Fields, diagnostics?: string) =>
    this.write('WARN', event, message, fields, diagnostics);

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

  private write(level: Level, event: string, message: string, fields: Fields = {}, diagnostics?: string) {
    if (!this.isLevelEnabled(level)) {
      return;
    }

    try {
      const all = { ...this.context, ...fields };
      const data = safeFields(all, new WeakSet([all]), 0);

      const timestamp = (this.options.clock?.() ?? new Date()).toISOString();
      const prefix = `${timestamp} ${level}`;
      const summary = String(safe(message));
      const header = `${prefix} ${safe(event)} ${summary}`;
      const historyFields = fieldText(data);
      this.remember(historyFields ? `${header} ${historyFields}` : header);

      // Text logs print each error the way Node does, stack and causes on their own lines.
      const traces = Object.values(all)
        .filter((value) => value instanceof Error)
        .map((error) => `\n${multiline(inspect(error, { depth: 4 })).slice(0, 10_000)}`)
        .join('');

      const line = `${prefix} ${consoleMessage(event, summary, data)}`;
      const details = diagnostics?.trimEnd();
      this.sink(`${line}${details ? `\n${multiline(details)}` : ''}${traces}`, level);
    } catch {
      // Logging must never interrupt a request, network callback, or shutdown.
    }
  }
}
