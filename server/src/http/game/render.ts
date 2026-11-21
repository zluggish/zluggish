import { packageRoot } from '#src/config/load';
import type { FormResult, GamePageModel, GameSaved } from '#src/dtos/game-app.dto';
import { browserJson } from '#src/http/game/results';
import { zwiftHostNames } from '#src/http/client-setup';
import { RuntimeContext } from '#src/context';
import type { Context } from 'hono';
import { Effect, Schema } from 'effect';
import { FilesService } from '#src/services/files.service';
import { TlsService } from '#src/services/tls.service';
import { resolve } from 'node:path';

function serialize(props: GamePageModel) {
  return JSON.stringify(props)
    .replaceAll('<', String.raw`\u003c`)
    .replaceAll('>', String.raw`\u003e`)
    .replaceAll('&', String.raw`\u0026`);
}

const document = Effect.fn('game.document')(function* (props: GamePageModel, rendered: { head: string; body: string }) {
  const files = yield* FilesService;

  const manifest = Schema.decodeUnknownSync(
    Schema.Record(
      Schema.String,
      Schema.Struct({ file: Schema.String, css: Schema.optional(Schema.Array(Schema.String)) }),
    ),
  )(JSON.parse(yield* files.readText(resolve(packageRoot(), '../web/dist/game/client/.vite/manifest.json'))));

  const entry = manifest['src/game/client.ts'];

  if (!entry) {
    throw new Error('Build the game app with pnpm build:web first');
  }

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${rendered.head}${(entry.css ?? []).map((file) => `<link rel="stylesheet" href="/static/launcher-ui/${file}">`).join('')}</head><body><div id="launcher-ui">${rendered.body}</div><script type="application/json" id="launcher-props">${serialize(props)}</script><script type="module" src="/static/launcher-ui/${entry.file}"></script></body></html>`;
});

/** The launcher page for model, or its form result as JSON when the browser posted with fetch. */
export const gamePage = Effect.fn('game.page')(function* (c: Context, page: GamePageModel, redirect?: string) {
  const { config } = yield* RuntimeContext;
  const shown: GamePageModel = {
    ...page,
    webApp: config.network.web.enabled ? config.network.web.publicUrl : null,
  };

  if (page.kind === 'login' || page.kind === 'unlock') {
    shown.healthHosts = zwiftHostNames;
  }

  c.header('Cache-Control', 'no-store');
  const tls = yield* TlsService;

  const model: GamePageModel =
    tls.mode() === 'legacy'
      ? {
          ...shown,
          warning:
            'This server uses the shared Zwift certificate, whose private key is public. Others on your network could read your Zwift traffic, password included. Ask the server administrator to set up a server certificate.',
        }
      : shown;

  if (c.req.method === 'POST' && browserJson(c)) {
    const result: FormResult<GameSaved> = model.failed
      ? { ok: false, message: model.message ?? 'The form could not be saved.' }
      : { ok: true, data: { page: model }, message: model.message ?? 'Saved.' };

    return c.json(result, model.failed ? (model.errorStatus ?? 400) : 200);
  }

  if (redirect) {
    return c.redirect(redirect);
  }
  const { renderGamePage } = yield* Effect.promise(() => import('#game'));

  return c.html(yield* document(model, renderGamePage(model)));
});
