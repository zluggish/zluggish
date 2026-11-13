import type { Hono } from 'hono';
import { html } from 'hono/html';
import { HTTPException } from 'hono/http-exception';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Runtime, RuntimeEnv } from '#src/http/runtime';
import { authenticated, csrf, page } from '#src/http/routes/accounts';
import { resolveRiderSettings } from '#src/node/persistence/settings';

const downloadable = z.enum([
  'profile.bin',
  'achievements.bin',
  'user_storage.bin',
  'streaks.bin',
  'economy_config.txt',
]);

export function settingsRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  app.on(['GET', 'POST'], '/settings/:username/', async (c) => {
    const rider = authenticated(c);

    if (c.req.method === 'POST') {
      const form = await csrf(c, runtime);
      runtime.settings.save(rider.player_id, {
        ...runtime.settings.read(rider.player_id),
        'ghosts.enabled': form.enableghosts !== undefined,
        'workouts.trainingpeaks.bridgeFolder': z.string().catch('').parse(form.bridge_folder),
        'uploads.strava.method': z.enum(['paid', 'free']).parse(form.strava_method ?? 'paid'),
      });

      return c.redirect(`/settings/${rider.username}/`);
    }

    const settings = resolveRiderSettings(runtime.config.riderDefaults, runtime.settings.read(rider.player_id));

    return c.html(
      page(
        'Rider settings',
        html`<form method="post">
            <input type="hidden" name="csrf_token" value="${c.get('browser').csrf}" /><label
              ><input type="checkbox" name="enableghosts" ${settings.ghosts.enabled ? html`checked` : ''} />Enable
              ghosts</label
            ><label
              >TrainingPeaks export folder<input
                name="bridge_folder"
                value="${settings.workouts.trainingpeaks.bridgeFolder}" /></label
            ><label
              >Strava method<select name="strava_method">
                <option value="paid">API</option>
                <option value="free">Session cookie</option>
              </select></label
            ><button>Save preferences</button>
          </form>
          <h2>Rider data</h2>
          ${downloadable.options
            .filter((name) => existsSync(resolve(runtime.profiles.folder(rider.player_id), name)))
            .map(
              (name) =>
                html`<form method="post" action="/download">
                  <input type="hidden" name="csrf_token" value="${c.get('browser').csrf}" /><input
                    type="hidden"
                    name="filename"
                    value="${name}"
                  /><button>Download ${name}</button>
                </form>`,
            )}
          <p>
            <a href="/profile/${rider.username}/">Restore rider data or import a profile</a>
          </p>`,
      ),
    );
  });
  app.post('/download', async (c) => {
    const rider = authenticated(c);
    const form = await csrf(c, runtime);
    const file = downloadable.parse(form.filename);
    const path = resolve(runtime.profiles.folder(rider.player_id), file);

    if (!existsSync(path)) throw new HTTPException(404);

    return c.body(readFileSync(path), 200, {
      'Content-Disposition': `attachment; filename="${file}"`,
    });
  });
  app.get('/download/:id/avatarLarge.jpg', (c) => {
    const id = z.coerce.number().int().positive().safe().parse(c.req.param('id'));

    const path = resolve(runtime.profiles.folder(id), 'avatarLarge.jpg');

    if (!existsSync(path)) throw new HTTPException(404);

    return c.body(readFileSync(path), 200, { 'Content-Type': 'image/jpeg' });
  });
}
