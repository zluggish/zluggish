import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import type { Hono } from 'hono';
import { extname, relative, resolve } from 'node:path';

const types = new Map([
  ['.css', 'text/css'],
  ['.json', 'application/json'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.js', 'text/javascript'],
  ['.html', 'text/html; charset=utf-8'],
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

      if (!file || !runtime.services.files.exists(file) || !runtime.services.files.stat(file).isFile())
        return c.notFound();

      return c.body(runtime.services.files.read(file), 200, {
        'Content-Type': types.get(extname(file)) ?? 'application/octet-stream',
      });
    });

  serve('/style', resolve(runtime.assets, 'cdn/style'));
  serve('/static', resolve(runtime.assets, 'cdn/static'));
  serve('/mochi', resolve(runtime.config.storageDir, 'mochi'));

  // Launcher 1.1.17 requests game assets over HTTPS; the CDN listener can proxy them.
  // eslint-disable-next-line unicorn/prefer-https -- HTTP reaches the separate CDN listener and avoids a redirect loop.
  app.get('/gameassets/*', (c) => c.redirect(`http://cdn.zwift.com${c.req.path}`));
}
