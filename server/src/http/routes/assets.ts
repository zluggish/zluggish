import { t } from '#src/i18n/index';
import { Effect } from 'effect';
import { effectRoutes } from '#src/http/effect';
import { fileResponse } from '#src/http/file-response';
import { FilesService } from '#src/services/files.service';
import { packageRoot } from '#src/config/load';
import { gamePage } from '#src/http/game/render';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import type { Context, Env, Hono } from 'hono';
import { extname, relative, resolve } from 'node:path';

const types = new Map([
  ['.css', 'text/css'],
  ['.json', 'application/json'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.js', 'text/javascript'],
  ['.woff2', 'font/woff2'],
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

export function launcherAssetRoutes<E extends Env>(app: Hono<E>, runtime: Runtime) {
  const appRoutes = effectRoutes(app, runtime);

  appRoutes.get('/static/launcher-ui/*', (c) =>
    Effect.gen(function* () {
      const filesService = yield* FilesService;

      const file = inside(
        resolve(packageRoot(), '../web/dist/game/client/assets'),
        c.req.path.slice('/static/launcher-ui/assets'.length),
      );

      if (!file || !c.req.path.startsWith('/static/launcher-ui/assets/') || !(yield* filesService.isFile(file))) {
        return c.notFound();
      }

      return yield* fileResponse(c, file, {
        'Content-Type': types.get(extname(file)) ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
    }),
  );

  appRoutes.get('/static/web/launcher/embed.html', (c) =>
    gamePage(c, {
      kind: 'message',
      title: t('loading_zwift_'),
      message: t('assets_github_star_prompt'),
      csrf: '',
      version: '',
      forms: [],
    }),
  );
}

export function assetRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  launcherAssetRoutes(app, runtime);
  const appRoutes = effectRoutes(app, runtime);

  const serve = (prefix: string, root: string) =>
    // Streamed: mochi route videos are tens of megabytes each and the game requests several at once.
    appRoutes.get(`${prefix}/*`, (c) =>
      Effect.gen(function* () {
        const filesService = yield* FilesService;

        const file = inside(root, c.req.path.slice(prefix.length));

        if (!file || !(yield* filesService.isFile(file))) {
          return c.notFound();
        }

        return yield* fileResponse(c, file, { 'Content-Type': types.get(extname(file)) ?? 'application/octet-stream' });
      }),
    );

  // Launcher 1.1.17 requests game assets over HTTPS; the CDN listener can proxy them.
  const redirectToCdn = (c: Context<RuntimeEnv>) =>
    // eslint-disable-next-line unicorn/prefer-https -- HTTP reaches the separate CDN listener and avoids a redirect loop.
    c.redirect(`http://cdn.zwift.com${c.req.path}${new URL(c.req.url).search}`);

  app.get('/gameassets/*', redirectToCdn);
  app.get('/app/MacUpdate/*', redirectToCdn);
  app.get('/static/web/launcher/app/*', redirectToCdn);

  serve('/style', resolve(runtime.assets, 'cdn/style'));
  serve('/static', resolve(runtime.assets, 'cdn/static'));
  serve('/mochi', resolve(runtime.config.storageDir, 'mochi'));
}
