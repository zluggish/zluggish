import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';
import { mediumFixture } from '#tests/medium/support';
import { assertProtocol } from '#tests/medium/protocol';

const entries = z
  .array(
    z.object({
      endpoint: z.string(),
      method: z.string(),
      path: z.string(),
      audit: z.string(),
      scenario: z.string(),
      anonymous: z.number(),
      status: z.number(),
      contentType: z.string().nullable(),
      location: z.string().optional(),
      json: z.json().optional(),
      text: z.string().optional(),
    }),
  )
  .parse(JSON.parse(readFileSync(new URL('inventory.json', import.meta.url), 'utf8')));

await test('audit inventory includes every legacy method/path and additional registration', () => {
  assert.equal(entries.filter((entry) => entry.audit !== 'Additional').length, 218);
  assert.equal(entries.length, 254);
  assert.equal(new Set(entries.map((entry) => entry.endpoint)).size, entries.length);
});

for (const entry of entries) {
  await test(`${entry.endpoint}: ${entry.scenario}`, async (t) => {
    const f = await mediumFixture(t);

    const path = entry.path
      .replaceAll('{rider}', () => String(f.rider.player_id))
      .replaceAll('{other}', () => String(f.other.player_id))
      .replaceAll('medium-rider', () => f.rider.username);

    const init = {
      method: entry.method,
      headers: { 'Content-Type': 'application/json' },
      ...(entry.method !== 'GET' && { body: '{}' }),
    };

    const anonymous = await f.app.request(path, init);
    assert.equal(anonymous.status, entry.anonymous, 'anonymous status');
    const response = await f.request(path, init);
    assert.equal(response.status, entry.status, 'signed rider status');
    assert.equal(response.headers.get('Content-Type'), entry.contentType);

    if (entry.location !== undefined)
      assert.equal(
        response.headers.get('Location'),
        entry.location.replaceAll('{username}', () => f.rider.username),
      );

    if ('json' in entry) assert.deepEqual(await response.json(), entry.json);
    else if (entry.text !== undefined) assert.equal(await response.text(), entry.text);
    else if (entry.contentType?.startsWith('text/html')) assert.match(await response.text(), /<!doctype html>/i);
    else await assertProtocol(path, response);

    // Invalid bearer credentials must never fall through to a public or anonymous handler.
    const invalid = await f.app.request(path, {
      ...init,
      headers: { ...init.headers, Authorization: 'Bearer invalid' },
    });

    assert.equal(invalid.status, 401);
  });
}

const pattern = (path: string) =>
  new RegExp(
    `^${path
      .split('/')
      .map((segment) => {
        if (segment === '*') return '.*';

        if (segment.startsWith(':')) {
          const constraint = /^:[A-Za-z_][A-Za-z_0-9]*(?:\{(.+)\})?$/.exec(segment)?.[1];

          return `(?:${constraint ?? '[^/]+'})`;
        }

        return segment.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/')}$`,
  );

await test('every registered method/path is represented in the audit inventory', async (t) => {
  const f = await mediumFixture(t);

  const missing = [
    ...new Set(
      f.app.routes
        .filter((r) => r.method !== 'ALL')
        .filter((r) =>
          entries.every((entry) => !(entry.method === r.method && pattern(r.path).test(entry.path.split('?', 1)[0]!))),
        )
        .map((r) => `${r.method} ${r.path}`),
    ),
  ];

  assert.deepEqual(missing, [], 'Add explicit inventory cases when registering endpoints');
});
