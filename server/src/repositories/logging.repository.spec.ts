import { validateConfig } from '#src/config/index';
import { LoggingRepository } from '#src/repositories/logging.repository';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('levels, aliases and independent loggers', () => {
  const lines: string[] = [];

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
    const output: string[] = [];

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

await test('safe serialization and sink failure containment', () => {
  const lines: string[] = [];

  const log = new LoggingRepository({
    format: 'json',
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
    error: new Error('sensitive-error-token'),
    circular,
  });
  assert.doesNotMatch(lines[0]!, /sensitive-/);
  const entry = JSON.parse(lines[0]!);
  assert.equal(entry.fields.playerId, '42');
  assert.equal(entry.timestamp, '1970-01-01T00:00:00.000Z');
  assert.equal(entry.fields.circular.self, '[truncated]');
  assert.equal(entry.message, 'Save failed next');
  assert.doesNotThrow(() =>
    new LoggingRepository({
      sink: () => {
        throw new Error('broken pipe');
      },
    }).info('ride.started', 'Ride'),
  );
  assert.throws(() => validateConfig({ logging: { rideProgressIntervalSeconds: 1 } }));
});

await test('children share configuration and retain their own context', () => {
  const lines: string[] = [];

  const repository = new LoggingRepository({
    format: 'json',
    sink: (line) => {
      lines.push(line);
    },
  });

  const child = repository.child({ component: 'import' });
  repository.configure({ level: 'ERROR' });
  child.warn('import.warning', 'Hidden');
  child.error('import.failed', 'Failed', { playerId: 42 });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!).fields, { component: 'import', playerId: 42 });
  repository.configure({ level: 'INFO' });
  child.info('import.finished', 'Finished');
  repository.info('server.ready', 'Ready');
  assert.equal(lines.length, 3);
  assert.deepEqual(JSON.parse(lines[2]!).fields, {});
});
