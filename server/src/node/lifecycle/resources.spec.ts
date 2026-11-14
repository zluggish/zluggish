import { Resources } from '#src/node/lifecycle/resources';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('cleanup is shared and completes every disposer after a failure', async () => {
  const resources = new Resources();
  const seen: string[] = [];
  const gate = Promise.withResolvers<void>();
  resources.defer(() => {
    seen.push('lock');
  });
  resources.defer(() => {
    seen.push('database');
    throw new Error('database close');
  });
  resources.defer(async () => {
    seen.push('worker');
    await gate.promise;
  });
  const first = resources.close();
  assert.equal(resources.close(), first);
  assert.equal(resources.status, 'closing');
  assert.throws(() => resources.defer(() => {}), /closing/);
  gate.resolve();
  await assert.rejects(first, AggregateError);
  assert.deepEqual(seen, ['worker', 'database', 'lock']);
  assert.equal(resources.status, 'closed');
  await resources.close();
  assert.equal(seen.length, 3);
});

await test('cleanup sees closing state before executing reentrant disposers', async () => {
  const resources = new Resources();
  let reentrant: Promise<void> | undefined;
  resources.defer(() => {
    reentrant = resources.close();
  });
  const closing = resources.close();
  await closing;
  assert.equal(reentrant, closing);
});
