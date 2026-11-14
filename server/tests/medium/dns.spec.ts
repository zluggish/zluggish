import { startDns } from '#src/node/network/dns';
import { decode, encode, RECURSION_DESIRED } from 'dns-packet';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { once } from 'node:events';
import { test } from 'node:test';

await test(
  'DNS redirects Zwift hosts, filters address families and survives malformed packets',
  { timeout: 5000 },
  async (t) => {
    const listener = startDns('192.0.2.42', '127.0.0.1', 0);
    await once(listener.socket, 'listening');
    t.after(() => listener.close());
    const client = createSocket('udp4');
    t.after(() => client.close());
    const port = listener.socket.address().port;
    client.send(Buffer.from([255]), port, '127.0.0.1');
    const received = once(client, 'message');
    client.send(
      encode({
        type: 'query',
        id: 42,
        flags: RECURSION_DESIRED,
        questions: [
          { type: 'A', name: 'SECURE.ZWIFT.COM.' },
          { type: 'A', name: 'us-or-rly101.zwift.com' },
          { type: 'A', name: 'cdn.zwift.com' },
          { type: 'A', name: 'launcher.zwift.com' },
          { type: 'AAAA', name: 'secure.zwift.com' },
        ],
      }),
      port,
      '127.0.0.1',
    );
    const [bytes] = await received;
    const response = decode(bytes);
    assert.equal(response.id, 42);
    assert.equal(response.type, 'response');
    assert.deepEqual(
      response.answers?.map((answer) => (answer.type === 'A' ? answer.data : null)),
      ['192.0.2.42', '192.0.2.42', '192.0.2.42', '192.0.2.42'],
    );
  },
);

await test(
  'DNS caches upstream answers and resolves IPv6 redirects without upstream access',
  { timeout: 5000 },
  async (t) => {
    const upstream = t.mock.method(Resolver.prototype, 'resolve4', () => Promise.resolve(['192.0.2.7']));
    const listener = startDns('2001:db8::1', '127.0.0.1', 0);
    await once(listener.socket, 'listening');
    t.after(() => listener.close());
    const client = createSocket('udp4');
    t.after(() => client.close());

    for (const id of [1, 2]) {
      const received = once(client, 'message');
      client.send(
        encode({
          type: 'query',
          id,
          questions: [
            { type: 'A', name: 'example.test' },
            { type: 'AAAA', name: 'secure.zwift.com' },
          ],
        }),
        listener.socket.address().port,
        '127.0.0.1',
      );
      const [bytes] = await received;
      assert.deepEqual(
        decode(bytes).answers?.map((answer) => (answer.type === 'A' || answer.type === 'AAAA' ? answer.data : null)),
        ['192.0.2.7', '2001:db8::1'],
      );
    }

    assert.equal(upstream.mock.callCount(), 1);
  },
);
