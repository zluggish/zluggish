import { decodeConfigInput, validateConfig } from '#src/config/index';
import { BuildLog } from '#src/repositories/build-log.repository';
import { LoggingRepository } from '#src/repositories/logging.repository';
import { ToolchainProcessError } from '#src/repositories/toolchain.repository';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('levels, aliases and independent loggers', () => {
  const lines: Array<string> = [];

  const info = new LoggingRepository({
    sink: (line) => {
      lines.push(line);
    },
  });

  const verbose = new LoggingRepository({
    level: 'VERBOSE',
    sink: (line) => {
      lines.push(line);
    },
  });

  info.verbose('http.completed', 'hidden');
  verbose.verbose('http.completed', 'visible');
  info.info('ride.started', 'visible');
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /VERBOSE/);
  assert.equal(validateConfig({ logging: { level: 'DEBUG' } }).logging.level, 'VERBOSE');

  for (const level of ['WARN', 'WARNING', 'ERROR', 'CRITICAL', 'NOTSET'] as const) {
    const output: Array<string> = [];

    const log = new LoggingRepository({
      level,
      sink: (line) => {
        output.push(line);
      },
    });

    log.info('test.info', 'Info');
    log.warn('test.warn', 'Warning');
    log.error('test.error', 'Error');
    log.critical('test.critical', 'Critical');
    assert.equal(output.length, level === 'NOTSET' ? 4 : level === 'ERROR' ? 2 : level === 'CRITICAL' ? 1 : 3);
  }
});

await test('logging configuration has no format selector', () => {
  assert.equal('format' in validateConfig({}).logging, false);
  assert.throws(() => decodeConfigInput({ logging: { format: 'json' } }), /format/);
});

await test('safe serialization and sink failure containment', () => {
  const lines: Array<string> = [];

  const log = new LoggingRepository({
    sink: (line) => {
      lines.push(line);
    },
    clock: () => new Date(0),
  });

  const circular = {};
  Object.assign(circular, { self: circular });
  log.error('activity.save_failed', 'Save failed\nnext', {
    playerId: 42n,
    token: 'sensitive-token',
    nested: { password: 'sensitive-password' },
    circular,
  });
  assert.doesNotMatch(lines[0]!, /sensitive-/);
  assert.match(lines[0]!, /^1970-01-01T00:00:00.000Z ERROR Save failed next \(rider #42\)$/);
  assert.match(log.recentEntries()[0]!, /playerId=42/);
  assert.match(log.recentEntries()[0]!, /circular\.self=\[truncated\]/);
  assert.doesNotThrow(() =>
    new LoggingRepository({
      sink: () => {
        throw new Error('broken pipe');
      },
    }).info('ride.started', 'Ride'),
  );
  assert.throws(() => validateConfig({ logging: { rideProgressIntervalSeconds: 1 } }));
});

await test('errors keep their message, stack and cause', () => {
  const lines: Array<string> = [];

  const sink = (line: string) => {
    lines.push(line);
  };

  const error = new Error('outer failure', { cause: new TypeError('inner failure') });

  new LoggingRepository({ sink }).error('web.failed', 'Failed', { error });
  const [line, ...trace] = lines[0]!.split('\n');
  assert.match(line!, /ERROR Failed$/);
  assert.match(trace[0]!, /^Error: outer failure$/);
  assert.match(trace[1]!, /^\s+at /);
  assert.ok(trace.some((frame) => frame.includes('[cause]: TypeError: inner failure')));
});

await test('tool diagnostics reach the backend log in full', async () => {
  const lines: Array<string> = [];
  const log = new LoggingRepository({
    sink: (line) => {
      lines.push(line);
    },
  });
  const job = new BuildLog(log, 'companion', 'Zwift Companion');
  const frames = '\tat example.Decoder.read(Decoder.java:42)\n'.repeat(500);
  const stderr = `Exception in thread "main" java.lang.OutOfMemoryError: Java heap space\n${frames}\tat example.Main.main(Main.java:1)`;
  const error = new ToolchainProcessError('java exited with code 1', stderr);

  await assert.rejects(
    job.tool('APKEditor', ['d'], () => Promise.reject(error)),
    error,
  );

  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /WARN APKEditor failed/);
  assert.ok(lines[1]!.includes(stderr));
  assert.doesNotMatch(log.recentEntries()[0]!, /OutOfMemoryError/);
});

await test('children share configuration and retain their own context', () => {
  const lines: Array<string> = [];

  const repository = new LoggingRepository({
    sink: (line) => {
      lines.push(line);
    },
  });

  const child = repository.child({ component: 'import' });
  repository.configure({ level: 'ERROR' });
  child.warn('import.warning', 'Hidden');
  child.error('import.failed', 'Failed', { playerId: 42 });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /ERROR Failed \(rider #42\)$/);
  assert.match(child.recentEntries()[0]!, /component=import playerId=42$/);
  repository.configure({ level: 'INFO' });
  child.info('import.finished', 'Finished');
  repository.info('server.ready', 'Ready', { host: '::1', port: 443, dns: false });
  assert.equal(lines.length, 3);
  assert.match(lines[2]!, /INFO Server ready on \[::1\]:443$/);
});

await test('recent entries are bounded, shared with children, and respect the configured level', () => {
  const log = new LoggingRepository({ sink: () => {} });
  const child = log.child({ component: 'test' });
  child.verbose('test.verbose', 'Hidden');
  assert.deepEqual(log.recentEntries(), []);

  for (let i = 0; i < 200; i++) {
    log.info('test.entry', `Entry ${i}`);
  }
  child.warn('test.warning', 'Newest');
  const entries = log.recentEntries();
  assert.equal(entries.length, 200);
  assert.match(entries[0]!, /test.warning Newest component=test$/);
  assert.match(entries.at(-1)!, /test.entry Entry 1$/);
  assert.deepEqual(child.recentEntries(), entries);

  const error = Object.assign(new Error('Failure'), { password: 'secret-value' });
  log.error('test.error', 'Failure', { error });
  assert.doesNotMatch(log.recentEntries()[0]!, /secret-value/);

  log.error('test.large', 'Large entry', { error: new Error('x'.repeat(10_000)) });
  const newest = log.recentEntries()[0]!;
  assert.ok(newest.length < 4200);
  assert.match(newest, /\[truncated\]$/);
});
