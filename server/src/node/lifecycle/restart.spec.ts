import { RestartScheduler } from '#src/node/lifecycle/restart';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('countdown, grace, firing and repeated start have explicit boundaries', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const messages: string[] = [];
  let stopped = 0;

  const scheduler = new RestartScheduler(
    (message) => {
      messages.push(message);
    },
    () => stopped++,
    { minutes: 2, intervalMs: 100, graceMs: 20 },
  );

  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.start(), false);
  t.mock.timers.tick(100);
  assert.equal(messages.length, 2);
  t.mock.timers.tick(100);
  assert.equal(messages.length, 3);
  assert.match(messages[2] ?? '', /See you later/);
  t.mock.timers.tick(19);
  assert.equal(stopped, 0);
  t.mock.timers.tick(1);
  assert.equal(stopped, 1);
  assert.equal(scheduler.active, false);
  t.mock.timers.tick(1000);
  assert.equal(stopped, 1);
});

for (const grace of [false, true])
  await test(`cancellation fences old callbacks: grace=${grace}`, (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    let stopped = 0;

    const scheduler = new RestartScheduler(
      () => {},
      () => stopped++,
      { minutes: 1, intervalMs: 100, graceMs: 20 },
    );

    assert.equal(scheduler.cancel(), false);
    scheduler.start();

    if (grace) t.mock.timers.tick(100);
    assert.equal(scheduler.cancel(), true);
    scheduler.start();
    t.mock.timers.tick(20);
    assert.equal(stopped, 0);
    scheduler.cancel();
    t.mock.timers.tick(1000);
    assert.equal(stopped, 0);
  });

await test('zero-minute countdown enters grace without leaving a repeating timer', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let stopped = 0;

  const scheduler = new RestartScheduler(
    () => {},
    () => stopped++,
    { minutes: 0, intervalMs: 10, graceMs: 5 },
  );

  scheduler.start();
  t.mock.timers.tick(100);
  assert.equal(stopped, 1);
  assert.equal(scheduler.active, false);
});
