import { RestartScheduler } from '#src/node/lifecycle/restart';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('restart countdown announces and asks the process to stop unless cancelled', async () => {
  const messages: string[] = [];
  let stopped = 0;

  const scheduler = new RestartScheduler(
    (message) => {
      messages.push(message);
    },
    () => stopped++,
    { minutes: 2, intervalMs: 5, graceMs: 5 },
  );

  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.start(), false);
  await new Promise((done) => setTimeout(done, 80));
  assert.equal(stopped, 1);
  assert.equal(scheduler.active, false);
  assert.equal(messages.length, 3);
  assert.match(messages[0] ?? '', /in 2 minutes/);
  assert.match(messages[1] ?? '', /in 1 minutes/);
  assert.match(messages[2] ?? '', /See you later/);

  const cancelled: string[] = [];

  const second = new RestartScheduler(
    (message) => {
      cancelled.push(message);
    },
    () => stopped++,
    { minutes: 2, intervalMs: 5, graceMs: 5 },
  );

  assert.equal(second.cancel(), false);
  second.start();
  assert.equal(second.cancel(), true);
  await new Promise((done) => setTimeout(done, 40));
  assert.equal(stopped, 1);
  assert.match(cancelled.at(-1) ?? '', /^Restart of the server has been cancelled/);
});
