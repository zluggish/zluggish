import { t } from '#src/i18n/index';
import type { FormResult, GameSaved } from '#src/dtos/game-app.dto';
import type { RuntimeEnv } from '#src/http/runtime';
import type { Context } from 'hono';

// Explicit browser routes only. Protocol APIs and the native handoff are excluded.
const routes = [/^\/login\/$/, /^\/riders\/(?:add|switch)\/$/, /^\/user\/[^/]+\/$/, /^\/ui\/status\/session$/];

export function browserJson(c: Context) {
  return c.req.header('Accept')?.includes('application/json') && routes.some((route) => route.test(c.req.path));
}

export function navigationPath(path: string) {
  return (
    /^\/(?:login\/|riders\/add\/|user\/[^/?#]+\/)$/.test(path) && !path.includes('\\') && !/%(?:2f|5c)/i.test(path)
  );
}

export function gameRedirect(c: Context<RuntimeEnv>, path: string) {
  if (!navigationPath(path)) {
    throw new Error(t('unsafe_game_app_redirect'));
  }
  c.header('Cache-Control', 'no-store');

  if (!browserJson(c)) {
    return c.redirect(path);
  }
  const result: FormResult<GameSaved> = { ok: true, data: {}, redirectTo: path };

  return c.json(result);
}
