import { envBoolean, envInteger, validateConfig } from '#src/config/index';
import { configSchema } from '#src/config/schema';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('runtime validation rejects unknown, non-finite, invalid ranges and duplicate group IDs', () => {
  for (const input of [
    { server: { multiplayer: true } },
    { network: { api: { port: 0 } } },
    { bots: { multiplier: 101 } },
    { soloBlob: { rowGap: 0 } },
    { soloBlob: { riders: 31 } },
    { soloBlob: { rowGap: Infinity } },
    { pelotons: [{ id: 'x', pacer: 1, bots: 201 }] },
  ]) {
    assert.equal(configSchema.safeParse(input).success, false);
  }

  assert.throws(
    () =>
      validateConfig({
        pelotons: [
          { id: 'x', pacer: 1 },
          { id: 'x', pacer: 2 },
        ],
      }),
    /duplicate/,
  );
  assert.throws(() => envBoolean('yes'));
  assert.throws(() => envInteger('8e3', 1));
  assert.equal(envBoolean('false'), false);
  assert.equal(envInteger('8080', 1), 8080);
});
