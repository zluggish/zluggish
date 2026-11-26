/** Reads the server's text log lines back into their parts: `<iso time> <LEVEL> <event> <message> key=value…`. */

export type LogSeverity = 'verbose' | 'info' | 'warning' | 'error' | 'critical';

export type LogField = { key: string; value: string };

export type LogEntry = {
  raw: string;
  time: Date | null;
  severity: LogSeverity;
  event: string;
  message: string;
  fields: Array<LogField>;
  truncated: boolean;
};

const severities = new Map<string, LogSeverity>(
  Object.entries({
    NOTSET: 'verbose',
    VERBOSE: 'verbose',
    DEBUG: 'verbose',
    INFO: 'info',
    WARN: 'warning',
    WARNING: 'warning',
    ERROR: 'error',
    CRITICAL: 'critical',
  } satisfies Record<string, LogSeverity>),
);

/** How much each severity weighs, for filtering and for the height of its bar. */
export const rank: Record<LogSeverity, number> = { verbose: 0, info: 1, warning: 2, error: 3, critical: 4 };

const truncatedMark = '… [truncated]';
const head = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) ([A-Z]+) (\S+) ?([\s\S]*)$/;

// Values are either plain tokens or util.inspect() strings, which may be split into `'a\n' +\n  'b'`.
const quoted = String.raw`'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\`(?:[^\`\\]|\\.)*\``;
const name = String.raw`(?:[\w-]+|'(?:[^'\\]|\\.)*')`;
const key = String.raw`${name}(?:\.${name})*`;
const value = String.raw`(?:(?:${quoted})(?:\s*\+\s*(?:${quoted}))*|[^\s'"\`]\S*)`;
const field = new RegExp(String.raw`(${key})=(${value})`, 'gy');
const fieldList = new RegExp(String.raw`^${key}=${value}(?: ${key}=${value})*$`);

// The server cuts messages at 500 characters, so the fields start within the first few hundred.
const messageLimit = 520;

function unquote(text: string) {
  const parts = text.match(new RegExp(quoted, 'g'));

  if (!parts || !/^['"`]/.test(text)) {
    return text;
  }

  return parts
    .map((part) =>
      part
        .slice(1, -1)
        .replaceAll(String.raw`\n`, '\n')
        .replaceAll(String.raw`\t`, '\t')
        .replaceAll(/\\(['"`\\])/g, '$1'),
    )
    .join('');
}

const partialField = new RegExp(String.raw`^(${key})=([\s\S]*)$`);

/** Reads `key=value` pairs from the start of `text`; a cut entry may end in half a field, kept with an ellipsis. */
function fieldsOf(text: string, truncated: boolean): Array<LogField> | null {
  const fields: Array<LogField> = [];
  let end = 0;
  field.lastIndex = 0;

  for (let match = field.exec(text); match; match = field.exec(text)) {
    fields.push({ key: match[1].replaceAll("'", ''), value: unquote(match[2]) });
    end = field.lastIndex;

    if (text[end] !== ' ') {
      break;
    }
    field.lastIndex = end + 1;
  }

  const rest = text.slice(end).trimStart();

  if (!rest) {
    return fields;
  }

  const partial = truncated && fields.length > 0 ? partialField.exec(rest) : null;

  if (!partial) {
    return null;
  }

  const value = partial[2].replace(/^['"`]/, '');
  return [...fields, { key: partial[1].replaceAll("'", ''), value: `${value}…` }];
}

function split(rest: string, truncated: boolean) {
  const limit = Math.min(rest.length, messageLimit);

  for (let start = 0; start <= limit; start = rest.indexOf(' ', start) + 1) {
    const tail = rest.slice(start);
    const fields = truncated || fieldList.test(tail) ? fieldsOf(tail, truncated) : null;

    if (fields) {
      return { message: rest.slice(0, Math.max(0, start - 1)), fields };
    }

    if (rest.indexOf(' ', start) === -1) {
      break;
    }
  }

  return { message: rest, fields: [] };
}

export function parseLogEntry(raw: string): LogEntry {
  const truncated = raw.endsWith(truncatedMark);
  const line = truncated ? raw.slice(0, -truncatedMark.length) : raw;
  const match = head.exec(line);
  const severity = match ? severities.get(match[2]) : undefined;

  if (!match || !severity) {
    return { raw, time: null, severity: 'info', event: '', message: line, fields: [], truncated };
  }

  const time = new Date(match[1]);
  const { message, fields } = split(match[4], truncated);

  return {
    raw,
    time: Number.isNaN(time.getTime()) ? null : time,
    severity,
    event: match[3],
    message,
    fields,
    truncated,
  };
}
