import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TrieRouter } from 'hono/router/trie-router';
import { z } from 'zod';
import { packageRoot } from '#src/config/load';
import { runtimeFixture } from '#tests/support/runtime';

const inventory = z.object({
  routes: z.array(
    z.object({
      path: z.string(),
      methods: z.array(z.string()),
      function: z.string(),
    }),
  ),
});

// Deliberate differences: these state-changing Flask GET routes are POST-only forms here.
const postOnly = new Set([
  '/restart',
  '/cancelrestart',
  '/reloadbots',
  '/delete/<path:filename>',
  '/intervals/<username>/sync',
  '/trainingpeaks/<username>/sync',
]);

function concrete(path: string) {
  return path
    .replaceAll(/<uuid:[^>]+>/g, '7c2b7f55-1f5e-4a3e-8a5e-0f1f4b7a1a11')
    .replaceAll(/<int:[^>]+>/g, '1')
    .replaceAll(/<path:[^>]+>/g, 'a')
    .replaceAll(/<[^>]+>/g, 'x');
}

await test('every legacy route is implemented, or its deliberate difference is recorded', (t) => {
  const f = runtimeFixture(t);
  const router = new TrieRouter<string>();

  for (const route of f.app.routes) if (route.path !== '/*') router.add(route.method, route.path, 'handler');

  const { routes } = inventory.parse(
    JSON.parse(readFileSync(resolve(packageRoot(), 'docs/legacy-inventory.json'), 'utf8')),
  );

  const missing = routes.flatMap((route) =>
    route.methods.flatMap((method) => {
      const wanted = postOnly.has(route.path) ? 'POST' : method;
      const path = concrete(route.path);
      const alternate = path.endsWith('/') ? path.slice(0, -1) : `${path}/`;

      const found = [path, alternate].some((candidate) => router.match(wanted, candidate)[0].length > 0);

      return found ? [] : `${method} ${route.path} (${route.function})`;
    }),
  );

  assert.deepEqual(missing, []);
});
