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

await test('network configuration rejects invalid advertised IPs and listener hosts', () => {
  for (const address of ['', ' ', 'server.local', '999.0.0.1', '0.0.0.0', '::', '0:0:0:0:0:0:0:0']) {
    assert.throws(() => validateConfig({ server: { advertisedIp: address } }), /server\.advertisedIp/);
  }

  for (const host of ['', ' ', 'server name', 'https://localhost', 'invalid:123', '999.0.0.1']) {
    assert.throws(() => validateConfig({ network: { host } }), /network\.host/);

    for (const listener of ['api', 'cdn', 'tcp', 'udp'] as const)
      assert.throws(
        () => validateConfig({ network: { [listener]: { host } } }),
        new RegExp(String.raw`network\.${listener}\.host`),
      );
  }

  for (const address of ['127.0.0.1', '192.0.2.1', '::1', '2001:db8::1'])
    assert.equal(validateConfig({ server: { advertisedIp: address } }).server.advertisedIp, address);

  for (const host of ['127.0.0.1', '0.0.0.0', '::', 'localhost', 'my_server.local'])
    assert.equal(validateConfig({ network: { host } }).network.host, host);

  assert.equal(validateConfig({ network: { tcp: { host: null } } }).network.tcp.host, null);
});
