import { RemovableCredentialFile, StravaMethod } from '#src/enum';
import { authenticated, csrf, page } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import { RestartScheduler } from '#src/node/lifecycle/restart';
import type { Rider } from '#src/repositories/accounts.repository';
import type { Context, Hono } from 'hono';
import { html } from 'hono/html';
import { HTTPException } from 'hono/http-exception';
import { resolve } from 'node:path';
import { z } from 'zod';

function admin(c: Env) {
  const rider = authenticated(c);

  return { rider, allowed: rider.is_admin !== 0 };
}

const token = (c: Env) => html`<input type="hidden" name="csrf_token" value="${c.get('browser').csrf}" />`;

type Env = Context<RuntimeEnv>;

const removable = z.enum(RemovableCredentialFile);

const text = z.string().catch('');

export function integrationRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const service = runtime.services.integrations;

  const connections = runtime.services.connections;

  const restart = new RestartScheduler(
    (message) => runtime.services.social.sendMessage(message),
    runtime.stop ?? (() => process.kill(process.pid, 'SIGINT')),
  );

  const folder = (rider: Rider) => runtime.services.profiles.folder(rider.player_id);

  function cookieOf(rider: Rider) {
    const file = resolve(folder(rider), 'strava4_session.txt');

    return runtime.services.files.exists(file)
      ? (runtime.services.files.read(file, 'utf8').split(/\r?\n/, 1)[0] ?? '')
      : '';
  }

  function stravaPage(c: Env, rider: Rider, message = '') {
    const method = runtime.services.settings.resolveRiderSettings(
      runtime.config.riderDefaults,
      runtime.services.settings.read(rider.player_id),
    ).uploads.strava.method;

    const client = connections.read(rider.player_id, 'strava');
    const authorized = runtime.services.files.exists(resolve(folder(rider), 'strava_token.txt'));

    return c.html(
      page(
        'Strava',
        html`${message ? html`<p>${message}</p>` : ''}
          <form method="post">
            ${token(c)}<label
              >Upload method<select name="method">
                <option value="paid" ${method === 'paid' ? 'selected' : ''}>API</option>
                <option value="free" ${method === 'free' ? 'selected' : ''}>Session cookie</option>
              </select></label
            ><button>Save method</button>
          </form>
          <h2>API</h2>
          <form method="post">
            ${token(c)}<label>Client ID<input name="client_id" value="${client?.[0] ?? ''}" /></label>
            <label
              >Client secret<input type="password" name="client_secret" placeholder="${client ? 'Saved' : ''}"
            /></label>
            <button>Save API credentials</button>
          </form>
          <p>
            ${authorized ? 'Authorized.' : 'Not authorized.'}
            ${client ? html`<a href="/strava_auth">Authorize with Strava</a>` : ''}
          </p>
          <h2>Session cookie</h2>
          <form method="post">
            ${token(c)}<label
              >_strava4_session<input
                type="password"
                name="_strava4_session"
                placeholder="${cookieOf(rider) ? 'Saved' : ''}"
            /></label>
            <button>Save cookie</button>
          </form>
          <p>${cookieOf(rider) ? html`<a href="/strava/${rider.username}/test">Test session</a>` : ''}</p>
          ${removable.options
            .filter((file) => file.startsWith('strava'))
            .map((file) =>
              runtime.services.files.exists(resolve(folder(rider), file))
                ? html`<form method="post" action="/delete/${file}">${token(c)}<button>Remove ${file}</button></form>`
                : '',
            )}`,
      ),
    );
  }

  function zwiftPage(c: Env, rider: Rider, message = '') {
    const connected = runtime.services.files.exists(connections.file(rider.player_id, 'zwift'));

    const settings = runtime.services.settings.resolveRiderSettings(
      runtime.config.riderDefaults,
      runtime.services.settings.read(rider.player_id),
    );

    return c.html(
      page(
        'Zwift connection',
        html`
          <p>${message}</p>
          <p>${connected ? 'Credentials saved.' : 'Save your official Zwift credentials to connect.'}</p>
          <form method="post">
            ${token(c)}<input type="hidden" name="action" value="settings" />
            <label>Username<input name="username" autocomplete="username" /></label>
            <label
              >Password<input
                type="password"
                name="password"
                autocomplete="new-password"
                placeholder="${connected ? 'Saved; leave blank to keep' : ''}"
            /></label>
            <label
              ><input type="checkbox" name="upload" ${settings.uploads.zwift.enabled ? 'checked' : ''} />Upload
              activities to Zwift</label
            >
            <label
              ><input type="checkbox" name="click" ${settings.devices.zwiftClick.enabled ? 'checked' : ''} />Enable
              Zwift Click authentication</label
            >
            <button>Save connection</button>
          </form>
          ${connected
            ? html`<form method="post">
                  ${token(c)}<input type="hidden" name="action" value="import" />
                  <label><input type="checkbox" name="profile" />Download profile and economy</label>
                  <label><input type="checkbox" name="achievements" />Download achievements</label>
                  <button>Download and review import</button>
                </form>
                <form method="post" action="/delete/zwift_credentials.bin">
                  ${token(c)}<button>Remove credentials</button>
                </form>`
            : ''}
          <a href="/profile/${rider.username}/">Import local files</a>
        `,
      ),
    );
  }

  app.on(['GET', 'POST'], '/zwift/:username/', async (c) => {
    const rider = authenticated(c);

    if (c.req.method === 'GET') return zwiftPage(c, rider);
    const form = await csrf(c, runtime);

    if (form.action === 'settings') {
      const username = text.parse(form.username).trim();
      const password = text.parse(form.password);

      if (username || password) {
        if (!username || !password) return zwiftPage(c, rider, 'Enter both username and password.');
        connections.save(rider.player_id, 'zwift', [username, password]);
      }

      if (!runtime.services.files.exists(connections.file(rider.player_id, 'zwift')) && (form.upload || form.click))
        return zwiftPage(c, rider, 'Save credentials before enabling uploads or Click.');
      runtime.services.settings.save(rider.player_id, {
        ...runtime.services.settings.read(rider.player_id),
        'uploads.zwift.enabled': form.upload === 'on',
        'devices.zwiftClick.enabled': form.click === 'on',
      });

      return zwiftPage(c, rider, 'Connection settings saved.');
    }

    if (form.action !== 'import') throw new HTTPException(400);
    const credentials = connections.read(rider.player_id, 'zwift');

    if (!credentials || (!form.profile && !form.achievements))
      return zwiftPage(c, rider, 'Save credentials and choose at least one download.');

    if (runtime.world.active(rider.player_id)) return zwiftPage(c, rider, 'Finish the active ride before importing.');

    try {
      const files = await runtime.services.integrations.downloadOfficialData(
        credentials[0],
        credentials[1],
        form.profile === 'on',
        form.achievements === 'on',
      );

      if (
        !runtime.services.sessions.current(
          c.get('browserId'),
          c.get('browser'),
          runtime.services.accounts.identityOf(rider),
        )
      )
        throw new Error('Import identity changed');
      const imports = runtime.services.imports;
      const stage = imports.prepare(rider, files);
      const browser = c.get('browser');

      if (browser.pendingImport) imports.cancel(rider, browser.pendingImport);
      runtime.services.sessions.transition(browser, { type: 'stage-import', stage });

      return c.redirect(`/profile/${rider.username}/confirm/`);
    } catch {
      return zwiftPage(c, rider, 'Download failed. Existing rider data was retained.');
    }
  });

  app.on(['GET', 'POST'], '/strava/:username/', async (c) => {
    const rider = authenticated(c);

    if (c.req.method !== 'POST') return stravaPage(c, rider);
    const form = await csrf(c, runtime);
    let message: string;

    if ('_strava4_session' in form) {
      const cookie = text.parse(form._strava4_session).trim();

      if (cookie) {
        runtime.services.files.write(resolve(folder(rider), 'strava4_session.txt'), cookie, true);
        message = 'Session cookie saved.';
      } else message = "Session cookie can't be empty.";
    } else if ('method' in form) {
      const method = z.enum(StravaMethod).safeParse(form.method);

      if (method.success) {
        runtime.services.settings.save(rider.player_id, {
          ...runtime.services.settings.read(rider.player_id),
          'uploads.strava.method': method.data,
        });
        message = 'Strava upload method saved.';
      } else message = 'Unknown upload method.';
    } else {
      const id = text.parse(form.client_id).trim();
      const secret = text.parse(form.client_secret).trim();

      if (id && secret) {
        connections.save(rider.player_id, 'strava', [id, secret]);
        message = 'Credentials saved.';
      } else message = "Client ID and secret can't be empty.";
    }

    return stravaPage(c, rider, message);
  });

  app.get('/strava/:username/test', async (c) => {
    const rider = authenticated(c);
    const cookie = cookieOf(rider);

    if (!cookie) return stravaPage(c, rider, 'No session configured.');

    try {
      return stravaPage(
        c,
        rider,
        (await runtime.services.integrations.checkSession(cookie))
          ? 'Session is valid.'
          : 'Session is not valid. Update the cookie.',
      );
    } catch {
      return stravaPage(c, rider, 'Could not reach Strava. Check your internet connection.');
    }
  });

  app.get('/strava_auth', (c) => {
    const rider = authenticated(c);
    const client = connections.read(rider.player_id, 'strava');

    if (!client?.[0]) return stravaPage(c, rider, 'Save API credentials first.');

    return c.redirect(runtime.services.integrations.authorizationUrl(client[0], c.get('browser').csrf));
  });

  app.on(['GET', 'POST'], '/authorization', async (c) => {
    const rider = authenticated(c);
    const client = connections.read(rider.player_id, 'strava');
    const code = c.req.query('code');

    // The state echoes this browser's CSRF token so a foreign code cannot be attached.
    const browserToken = c.get('browser').csrf;

    if (!client || !code || !browserToken || c.req.query('state') !== browserToken)
      return stravaPage(c, rider, 'Strava authorization canceled.');

    try {
      await service.authorizeStrava(c.get('browserId'), c.get('browser'), rider, code);

      return stravaPage(c, rider, 'Strava authorized.');
    } catch {
      return stravaPage(c, rider, 'Strava authorization canceled.');
    }
  });

  function garminPage(c: Env, rider: Rider, message = '') {
    const client = connections.read(rider.player_id, 'garmin');

    const authorized = runtime.services.files.exists(resolve(folder(rider), 'garth/oauth1_token.json'));

    return c.html(
      page(
        'Garmin',
        html`${message ? html`<p>${message}</p>` : ''}
          <form method="post">
            ${token(c)}<label>Username<input name="username" value="${client?.[0] ?? ''}" /></label>
            <label>Password<input type="password" name="password" placeholder="${client ? 'Saved' : ''}" /></label>
            <button>Save credentials</button>
          </form>
          <p>
            ${authorized ? 'Authorized.' : 'Not authorized.'}
            ${client
              ? html`<form method="post" action="/garmin_auth">${token(c)}<button>Authorize with Garmin</button></form>`
              : ''}
          </p>
          ${removable.options
            .filter((file) => file.startsWith('gar'))
            .map((file) =>
              runtime.services.files.exists(resolve(folder(rider), file))
                ? html`<form method="post" action="/delete/${file}">${token(c)}<button>Remove ${file}</button></form>`
                : '',
            )}`,
      ),
    );
  }

  app.on(['GET', 'POST'], '/garmin/:username/', async (c) => {
    const rider = authenticated(c);

    if (c.req.method !== 'POST') return garminPage(c, rider);
    const form = await csrf(c, runtime);
    const username = text.parse(form.username).trim();
    const password = text.parse(form.password);

    if (!username || !password) return garminPage(c, rider, "Garmin credentials can't be empty.");

    connections.save(rider.player_id, 'garmin', [username, password]);

    return garminPage(c, rider, 'Credentials saved.');
  });

  app.get('/garmin_auth', (c) => garminPage(c, authenticated(c), 'Use the authorization button to connect.'));
  app.post('/garmin_auth', async (c) => {
    const rider = authenticated(c);
    const form = await csrf(c, runtime);

    try {
      const outcome = await service.authorizeGarmin(
        c.get('browserId'),
        c.get('browser'),
        rider,
        form.code === undefined ? undefined : z.string().min(1).max(32).parse(form.code),
      );

      if (outcome === 'mfa')
        return c.html(
          page(
            'Garmin verification',
            html`<form method="post" action="/garmin_auth">
              ${token(c)}<label>Verification code<input name="code" autocomplete="one-time-code" required /></label>
              <button>Verify</button>
            </form>`,
          ),
        );

      return garminPage(c, rider, 'Garmin authorized.');
    } catch {
      return garminPage(c, rider, 'Garmin authorization failed or expired. Try again.');
    }
  });

  app.post('/delete/*', async (c) => {
    const rider = authenticated(c);
    await csrf(c, runtime);

    const file = removable.safeParse(decodeURIComponent(c.req.path.slice('/delete/'.length)));

    if (!file.success) throw new HTTPException(403);
    runtime.services.files.remove(resolve(folder(rider), file.data), { force: true });

    if (file.data.startsWith('strava')) return c.redirect(`/strava/${rider.username}/`);

    if (file.data.startsWith('garmin') || file.data.startsWith('garth'))
      return c.redirect(`/garmin/${rider.username}/`);

    return c.redirect(`/settings/${rider.username}/`);
  });

  app.on(['GET', 'POST'], '/power_curves/:username/', async (c) => {
    const rider = authenticated(c);

    if (c.req.method === 'POST') {
      const form = await csrf(c, runtime);

      service.deletePowerCurve(rider.player_id);

      if (!form.create) return c.redirect(`/settings/${rider.username}/`);
      const fit = resolve(folder(rider), 'fit');

      if (runtime.services.files.exists(fit))
        for (const name of runtime.services.files.list(fit))
          try {
            runtime.services.activities.savePowerCurve(
              rider.player_id,
              runtime.services.files.read(resolve(fit, name)),
            );
          } catch {
            runtime.world.lifecycle.log.warn('activity.power_curve_unavailable', 'Power curve unavailable');
          }

      return c.redirect(`/settings/${rider.username}/`);
    }

    return c.html(
      page(
        'Power curves',
        html`<form method="post">
          ${token(c)}<label><input type="checkbox" name="create" />Recreate from saved activities</label
          ><button>Delete existing power curves</button>
        </form>`,
      ),
    );
  });

  app.post('/api/d-lock-service/device/authenticate', async (c) => {
    const rider = authenticated(c);
    const credentials = connections.read(rider.player_id, 'zwift');

    const enabled = runtime.services.settings.resolveRiderSettings(
      runtime.config.riderDefaults,
      runtime.services.settings.read(rider.player_id),
    ).devices.zwiftClick.enabled;

    if (!enabled || !credentials) return c.body(null, 204);

    try {
      const token = await runtime.services.integrations.officialLogin(credentials[0], credentials[1]);

      const response = await runtime.services.integrations.request(
        `${runtime.services.integrations.officialRelay}/api/d-lock-service/device/authenticate`,
        {
          method: 'POST',
          headers: {
            ...runtime.services.integrations.officialHeaders(token),
            'Content-Type': c.req.header('Content-Type') ?? 'application/octet-stream',
            Accept: c.req.header('Accept') ?? '*/*',
          },
          body: new Uint8Array(await c.req.arrayBuffer()),
          signal: AbortSignal.timeout(30_000),
        },
      );

      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: {
          'Content-Type': response.headers.get('Content-Type') ?? 'application/octet-stream',
        },
      });
    } catch {
      return c.body(null, 204);
    }
  });

  app.post('/restart', async (c) => {
    const { rider, allowed } = admin(c);
    await csrf(c, runtime);

    if (allowed) restart.start();

    return c.redirect(`/user/${rider.username}/`);
  });

  app.post('/cancelrestart', async (c) => {
    const { rider, allowed } = admin(c);
    await csrf(c, runtime);

    if (allowed) restart.cancel();

    return c.redirect(`/user/${rider.username}/`);
  });

  app.post('/reloadbots', async (c) => {
    const { rider, allowed } = admin(c);
    await csrf(c, runtime);

    if (allowed) runtime.world.simulation?.reload();

    return c.redirect(`/user/${rider.username}/`);
  });
}
