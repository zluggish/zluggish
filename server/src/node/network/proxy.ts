import { request } from 'node:https';
import { Resolver } from 'node:dns';
import { Readable } from 'node:stream';

const resolver = new Resolver();

resolver.setServers(['8.8.8.8', '8.8.4.4']);

/** Resolve the upstream independently of the client's local Zwift hostname redirect. */
export async function fetchCdn(path: string): Promise<Response> {
  return new Promise((done, fail) => {
    const req = request(
      `https://cdn.zwift.com${path}`,
      {
        lookup(hostname, options, callback) {
          resolver.resolve4(hostname, (error, addresses) => {
            if (error || !addresses[0]) {
              callback(error ?? new Error('No upstream address'), '', 4);

              return;
            }

            if (options.all)
              callback(
                null,
                addresses.map((address) => ({ address, family: 4 })),
                4,
              );
            else callback(null, addresses[0], 4);
          });
        },
      },
      (response) => {
        response.once('error', fail);

        try {
          const headers = new Headers();

          for (const [name, value] of Object.entries(response.headers)) {
            if (['connection', 'transfer-encoding', 'keep-alive'].includes(name) || value === undefined) continue;

            if (Array.isArray(value)) for (const item of value) headers.append(name, item);
            else headers.set(name, value);
          }

          const status = response.statusCode ?? 502;

          if ([204, 205, 304].includes(status)) {
            response.resume();
            done(new Response(null, { status, headers }));
          } else {
            // SAFETY: Node returns a WHATWG byte stream; Node and DOM stream declarations differ in their BYOB overloads.
            const body = Readable.toWeb(response) as ReadableStream<Uint8Array>;
            done(new Response(body, { status, headers }));
          }
        } catch (error) {
          response.destroy();
          fail(error);
        }
      },
    );

    req.setTimeout(30_000, () => req.destroy(new Error('CDN proxy timeout')));
    req.once('error', fail);
    req.end();
  });
}
