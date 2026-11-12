import type { Hono } from 'hono';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import type { Runtime, RuntimeEnv } from '#src/http/runtime';

const types = new Map([
  ['.css', 'text/css'],
  ['.json', 'application/json'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.js', 'text/javascript'],
]);

function inside(root: string, path: string) {
  let target: string;

  try {
    target = resolve(root, `.${decodeURIComponent(path)}`);
  } catch {
    return null;
  }

  const within = relative(root, target);

  return within && !within.startsWith('..') && !within.includes('\0') ? target : null;
}

export function assetRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const serve = (prefix: string, root: string) =>
    app.get(`${prefix}/*`, (c) => {
      const file = inside(root, c.req.path.slice(prefix.length));

      if (!file || !existsSync(file) || !statSync(file).isFile()) return c.notFound();

      return c.body(readFileSync(file), 200, {
        'Content-Type': types.get(extname(file)) ?? 'application/octet-stream',
      });
    });

  serve('/style', resolve(runtime.assets, 'cdn/style'));
  serve('/mochi', resolve(runtime.config.storageDir, 'mochi'));

  // Launcher 1.1.17 requests game assets over HTTPS; the CDN listener can proxy them.
  app.get('/gameassets/*', (c) => c.redirect(`https://cdn.zwift.com${c.req.path}`));
}
