import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { html } from 'hono/html';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Workouts } from '#src/domain/workouts/planned';
import { Connections } from '#src/node/persistence/connections';
import { writeDurable } from '#src/node/persistence/files';
import type { Runtime, RuntimeEnv } from '#src/http/runtime';
import { authenticated, page, csrf } from '#src/http/routes/accounts';

export function workoutRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const workouts = new Workouts(runtime);
  app.get('/api/workout/schedule/list', (c) => {
    const user = authenticated(c);
    c.header('Cache-Control', 'private, no-store');

    return c.json(
      c.req.query('sport')?.toUpperCase() === 'RUNNING'
        ? []
        : workouts.list(user.player_id).map((item) => item.schedule),
    );
  });
  app.get('/api/head-unit-bff/game-home', (c) => {
    const user = authenticated(c);
    c.header('Cache-Control', 'private, no-store');

    return c.json(workouts.list(user.player_id)[0]?.home ?? {});
  });
  app.get('/api/head-unit-bff/carousels/for-you', (c) => {
    const user = authenticated(c);
    c.header('Cache-Control', 'private, no-store');

    return c.json(
      workouts.list(user.player_id).map((workout) => ({
        recommendationType: 'workout',
        workoutUUID: workout.id,
        workoutHash: null,
        assetUrl: workout.schedule.workoutUri,
        providerId: 'intervalsicu',
        provider: null,
        scheduleId: workout.schedule.scheduleId,
        score: 1,
        explanation: null,
        sourceData: null,
        source: 'SCHEDULED',
        sourceId: workout.schedule.scheduleId,
        ribbon: null,
        recommendedDurationMinutes: null,
      })),
    );
  });
  app.get('/api/workout/workouts/:id', (c) => {
    const user = authenticated(c);

    const workout = workouts.list(user.player_id).find((item) => item.id === c.req.param('id'));

    if (!workout) throw new HTTPException(404);
    c.header('Cache-Control', 'private, no-store');

    return c.json(workout.schedule.workoutSummary);
  });
  app.get('/tp-workouts/intervalsicu/:id', (c) => {
    const file = workouts.file(c.req.param('id').replace(/\.zwo$/, ''));

    if (!file || !existsSync(file)) throw new HTTPException(404);

    return c.body(readFileSync(file), 200, {
      'Content-Type': 'application/xml',
    });
  });
  app.get('/api/assetcms/*', (c) =>
    c.json(c.req.path.endsWith('/partner_name_map.json/download') ? { intervalsicu: 'Intervals.icu' } : null),
  );
  app.on(['GET', 'POST'], '/intervals/:username/', async (c) => {
    const user = authenticated(c);
    const connections = new Connections(runtime.config.storageDir);

    if (c.req.method === 'POST') {
      const form = await csrf(c, runtime);
      const athlete = z.string().regex(/^\d+$/).parse(form.athlete_id);
      const key = z.string().min(1).parse(form.api_key);
      connections.save(user.player_id, 'intervals', [athlete, key]);

      return c.redirect(`/settings/${user.username}/`);
    }

    const connected = existsSync(connections.file(user.player_id, 'intervals'));

    return c.html(
      page(
        'Intervals.icu',
        html`<p>${connected ? 'Connected' : 'Enter your athlete ID and API key.'}</p>
          <form method="post">
            <input type="hidden" name="csrf_token" value="${c.get('browser').csrf}" /><label
              >Athlete ID<input name="athlete_id" required /></label
            ><label>API key<input type="password" name="api_key" required /></label><button>Save connection</button>
          </form>
          <form method="post" action="/intervals/${user.username}/sync">
            <input type="hidden" name="csrf_token" value="${c.get('browser').csrf}" /><button>Sync workouts</button>
          </form>`,
      ),
    );
  });
  app.on(['GET', 'POST'], '/trainingpeaks/:username/', async (c) => {
    const user = authenticated(c);

    if (c.req.method === 'POST') {
      const form = await csrf(c, runtime);
      const overrides = runtime.settings.read(user.player_id);
      overrides['workouts.trainingpeaks.bridgeFolder'] = z.string().parse(form.bridge_folder).trim();
      runtime.settings.save(user.player_id, overrides);
    }

    return c.html(
      page(
        'TrainingPeaks bridge',
        html`<p>
            Export .zwo workouts to a local folder. Automatic TrainingPeaks API access requires approved partner
            credentials.
          </p>
          <form method="post">
            <input type="hidden" name="csrf_token" value="${c.get('browser').csrf}" /><label
              >Export folder<input
                name="bridge_folder"
                value="${runtime.settings.read(user.player_id)['workouts.trainingpeaks.bridgeFolder'] ??
                runtime.config.riderDefaults.workouts.trainingpeaks.bridgeFolder}" /></label
            ><button>Save folder</button>
          </form>
          <form method="post" action="/trainingpeaks/${user.username}/sync">
            <input type="hidden" name="csrf_token" value="${c.get('browser').csrf}" /><button>Import workouts</button>
          </form>`,
      ),
    );
  });
  app.post('/:provider{intervals|trainingpeaks}/:username/sync', async (c) => {
    const user = authenticated(c);
    await csrf(c, runtime);

    const provider = c.req.param('provider') === 'intervals' ? 'intervals-icu' : 'trainingpeaks';

    writeDurable(resolve(runtime.profiles.folder(user.player_id), 'active_workout_provider.txt'), provider, true);
    let message: string;

    try {
      message = await workouts.sync(user.player_id);
    } catch {
      message = 'Workout sync failed. Existing workouts were retained.';
    }

    return c.html(
      page(
        'Workout sync',
        html`<p>${message}</p>
          <a href="/settings/${user.username}/">Settings</a>`,
      ),
    );
  });
}
