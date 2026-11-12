import type { Hono, Context } from 'hono';
import { html } from 'hono/html';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import { HTTPException } from 'hono/http-exception';
import { resolve } from 'node:path';
import { z } from 'zod';
import { identityOf } from '#src/domain/accounts/repository';
import { resolveRiderSettings } from '#src/node/persistence/settings';
import type { Runtime, RuntimeEnv } from '#src/http/runtime';

export function page(title: string, body: ReturnType<typeof html>) {
  return html`<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width" />
        <title>${title}</title>
        <link rel="stylesheet" href="/style/site.css" />
        <style>
          body {
            font: 18px system-ui;
            max-width: 50rem;
            margin: 3rem auto;
            padding: 1rem;
            overflow: auto;
            min-height: calc(100vh - 8rem);
          }
          a {
            color: white;
            text-shadow: 1px 1px 2px black;
          }
          button {
            background: #f26722;
            color: white;
            border: 1px solid white;
            border-radius: 0.3rem;
            cursor: pointer;
          }
          input,
          button,
          select {
            font: inherit;
            padding: 0.5rem;
            margin: 0.4rem;
          }
          label {
            display: block;
          }
          nav {
            display: flex;
            gap: 1rem;
            flex-wrap: wrap;
          }
        </style>
      </head>
      <body>
        <h1 class="text-shadow">${title}</h1>
        ${body}
      </body>
    </html>`;
}

export function authenticated(c: Context<RuntimeEnv>) {
  const rider = c.get('rider');

  if (!rider) throw new HTTPException(401);

  return rider;
}

type FormFields = Record<string, string | File | (string | File)[]>;

export async function csrf(c: Context<RuntimeEnv>, runtime: Runtime): Promise<FormFields> {
  const form = await c.req.parseBody();

  if (!runtime.sessions.validCsrf(c.get('browser'), z.string().catch('').parse(form.csrf_token)))
    throw new HTTPException(400, {
      message: 'The form expired. Reload and retry.',
    });

  return z
    .record(z.string(), z.union([z.string(), z.instanceof(File), z.array(z.union([z.string(), z.instanceof(File)]))]))
    .parse(form);
}

export function peerAddress(c: Context<RuntimeEnv>) {
  try {
    return getConnInfo(c).remote.address ?? '';
  } catch {
    return '';
  }
}

export function accountRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const { accounts, sessions, world } = runtime;
  app.use('*', async (c, next) => {
    const authorization = c.req.header('Authorization');
    const existing = getCookie(c, 'zluggish_session');

    const opened = authorization
      ? {
          id: '',
          session: {
            csrf: '',
            identity: null,
            selected: false,
            pendingImport: null,
            touched: Date.now(),
          },
        }
      : sessions.open(existing);

    c.set('browser', opened.session);
    c.set('browserId', opened.id);

    if (!authorization && existing !== opened.id)
      setCookie(c, 'zluggish_session', opened.id, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: c.req.url.startsWith('https:'),
        path: '/',
        maxAge: 86_400,
      });
    c.set(
      'rider',
      authorization ? sessions.bearer(authorization.replace(/^Bearer /i, '')) : sessions.rider(opened.session),
    );

    if (authorization && !c.get('rider')) throw new HTTPException(401);

    await next();
  });

  app.get('/', (c) => c.redirect('/login/'));
  app.on(['GET', 'POST'], '/signup/', (c) => c.redirect('/riders/add/'));
  app.on(['GET', 'POST'], '/login/', async (c) => {
    const session = c.get('browser');
    session.selected = false;

    if (!accounts.setupComplete()) return c.redirect('/riders/add/');
    let error = '';

    if (c.req.method === 'POST') {
      const form = await csrf(c, runtime);

      const id = z.coerce.number().int().positive().safe().safeParse(form.player_id);

      const user = id.success ? accounts.get(id.data) : null;
      const password = z.string().catch('').parse(form.password);

      if (user && (!user.pass_hash || (await accounts.verify(user, password)))) {
        sessions.browsers.delete(c.get('browserId'));
        const fresh = sessions.open();
        fresh.session.identity = identityOf(user);
        fresh.session.selected = true;
        setCookie(c, 'zluggish_session', fresh.id, {
          httpOnly: true,
          sameSite: 'Lax',
          secure: c.req.url.startsWith('https:'),
          path: '/',
          maxAge: 86_400,
        });

        return c.redirect(`/user/${encodeURIComponent(user.username)}/`);
      }

      error = 'Invalid rider or password.';
    }

    return c.html(
      page(
        'Choose a rider',
        html`<p>${error}</p>
          ${accounts
            .list()
            .map(
              (user) =>
                html`<form method="post">
                  <input type="hidden" name="csrf_token" value="${session.csrf}" /><input
                    type="hidden"
                    name="player_id"
                    value="${user.player_id}"
                  /><strong>${user.first_name} ${user.last_name}</strong>${user.pass_hash
                    ? html`<input type="password" name="password" aria-label="Password" required />`
                    : ''}<button>Select rider</button>
                </form>`,
            )}<a href="/riders/add/">Add rider</a>`,
      ),
    );
  });

  app.on(['GET', 'POST'], '/riders/add/', async (c) => {
    const first = !accounts.setupComplete();
    const current = c.get('rider');

    if (!first && !runtime.config.accounts.allowSelfRegistration && !current?.is_admin) throw new HTTPException(403);
    const session = c.get('browser');
    let error = '';

    if (c.req.method === 'POST') {
      const form = await csrf(c, runtime);
      const password = z.string().catch('').parse(form.password);

      if (password === z.string().catch('').parse(form.confirm_password)) {
        await accounts.create(z.string().parse(form.display_name), password, first);

        return c.redirect('/login/');
      }

      error = 'Passwords did not match.';
    }

    return c.html(
      page(
        'Add rider',
        html`<p>${error}</p>
          <form method="post">
            <input type="hidden" name="csrf_token" value="${session.csrf}" /><label
              >Name<input
                name="display_name"
                value="${first ? 'zluggish' : ''}"
                maxlength="100"
                required
                autofocus /></label
            ><label>Optional password<input type="password" name="password" /></label
            ><label>Confirm password<input type="password" name="confirm_password" /></label
            ><button>Create rider</button> ${first ? '' : html`<a href="/login/">Cancel</a>`}
          </form>`,
      ),
    );
  });

  app.post('/riders/switch/', async (c) => {
    await csrf(c, runtime);
    sessions.browsers.delete(c.get('browserId'));
    deleteCookie(c, 'zluggish_session', { path: '/' });

    return c.redirect('/login/');
  });

  app.get('/user/:username/', (c) => {
    const user = authenticated(c);
    const session = c.get('browser');

    const settings = resolveRiderSettings(runtime.config.riderDefaults, runtime.settings.read(user.player_id));

    return c.html(
      page(
        `${user.first_name} ${user.last_name}`,
        html`<nav>
            <a href="/profile/${user.username}/">Profile</a><a href="/reset/${user.username}/">Password</a
            ><a href="/settings/${user.username}/">Settings</a><a href="/strava/${user.username}/">Strava</a
            ><a href="/garmin/${user.username}/">Garmin</a><a href="/intervals/${user.username}/">Intervals.icu</a
            ><a href="/trainingpeaks/${user.username}/">TrainingPeaks</a
            ><a href="/power_curves/${user.username}/">Power curves</a>
          </nav>
          <form method="post" action="/start-zwift">
            <input type="hidden" name="csrf_token" value="${session.csrf}" /><label
              >Map<select name="map">
                <option value="CALENDAR">Calendar</option>
                ${[
                  [2, 'Richmond'],
                  [6, 'Watopia'],
                  [7, 'London'],
                  [8, 'New York'],
                  [9, 'Innsbruck'],
                  [11, 'Yorkshire'],
                  [13, 'Makuri Islands'],
                  [14, 'France'],
                  [15, 'Paris'],
                  [17, 'Scotland'],
                ].map(([id, name]) => html`<option value="${id}">${name}</option>`)}
              </select></label
            ><input type="hidden" name="climb" value="CALENDAR" /><label
              ><input type="checkbox" name="enableghosts" ${settings.ghosts.enabled ? html`checked` : ''} />Enable
              ghosts</label
            ><button>Start Zwift</button>
          </form>
          <form method="post" action="/riders/switch/">
            <input type="hidden" name="csrf_token" value="${session.csrf}" /><button>Switch rider</button>
          </form>
          ${user.is_admin
            ? html`<h2>Server</h2>
                ${[
                  ['/restart', 'Restart with countdown'],
                  ['/cancelrestart', 'Cancel restart'],
                  ['/reloadbots', 'Reload bots'],
                ].map(
                  ([action, label]) =>
                    html`<form method="post" action="${action}">
                      <input type="hidden" name="csrf_token" value="${session.csrf}" /><button>${label}</button>
                    </form>`,
                )}`
            : ''}`,
      ),
    );
  });

  app.on(['GET', 'POST'], '/reset/:username/', async (c) => {
    const user = authenticated(c);

    if (c.req.method === 'POST') {
      const form = await csrf(c, runtime);

      if (user.pass_hash && !(await accounts.verify(user, z.string().catch('').parse(form.current_password))))
        throw new HTTPException(403);

      const password = form.remove_password === 'on' ? null : z.string().min(1).parse(form.password);

      if (password !== null && password !== form.confirm_password) throw new HTTPException(400);

      await accounts.changePassword(user.player_id, password);
      sessions.browsers.delete(c.get('browserId'));

      return c.redirect('/login/');
    }

    return c.html(
      page(
        'Local password',
        html`<form method="post">
          <input type="hidden" name="csrf_token" value="${c.get('browser').csrf}" />${user.pass_hash
            ? html`<label>Current password<input type="password" name="current_password" /></label>`
            : ''}<label>New password<input type="password" name="password" /></label
          ><label>Confirm password<input type="password" name="confirm_password" /></label
          ><label><input type="checkbox" name="remove_password" />Remove password</label><button>Save</button>
        </form>`,
      ),
    );
  });

  const launchAliases = [
    '/launcher',
    '/launcher/ride',
    '/launcher/realms/zwift/protocol/openid-connect/auth',
    '/launcher/realms/zwift/protocol/openid-connect/registrations',
    '/auth/realms/zwift/protocol/openid-connect/auth',
    '/auth/realms/zwift/login-actions/request/login',
    '/auth/realms/zwift/protocol/openid-connect/registrations',
    '/auth/realms/zwift/login-actions/startriding',
    '/auth/realms/zwift/tokens/login',
    '/auth/realms/zwift/tokens/registrations',
    '/ride',
  ];

  app.on(['GET', 'POST'], launchAliases, (c) => {
    const user = c.get('rider');

    if (c.req.path !== '/ride' || !user || !c.get('browser').selected) {
      c.get('browser').selected = false;

      return c.redirect('/login/');
    }

    if (world.active(user.player_id)) throw new HTTPException(409);

    return c.redirect(
      `http://zwift/?code=zwift_refresh_token${sessions.token(identityOf(user), runtime.tokens.refresh)}`,
    );
  });

  app.post('/start-zwift', async (c) => {
    const user = authenticated(c);
    const form = await csrf(c, runtime);

    if (!c.get('browser').selected) return c.redirect('/login/');

    if (world.active(user.player_id)) throw new HTTPException(409);

    runtime.settings.save(user.player_id, {
      ...runtime.settings.read(user.player_id),
      'ghosts.enabled': form.enableghosts !== undefined,
    });
    const address = peerAddress(c);

    if (form.map && form.map !== 'CALENDAR') world.mapOverrides.set(address, z.string().parse(form.map));

    if (form.climb && form.climb !== 'CALENDAR') world.climbOverrides.set(address, z.string().parse(form.climb));

    return c.redirect('/ride');
  });

  app.post('/auth/realms/zwift/protocol/openid-connect/token', async (c) => {
    const form = await c.req.parseBody();
    let user;

    if (form.username) {
      user = accounts.byUsername(z.string().parse(form.username));

      if (!user || !(await accounts.verify(user, z.string().catch('').parse(form.password))))
        throw new HTTPException(401);
    } else {
      const token = form.code ? z.string().parse(form.code) : z.string().parse(form.refresh_token);

      if (form.code && !token.startsWith('zwift_refresh_token')) throw new HTTPException(401);

      user = sessions.bearer(form.code ? token.slice(19) : token);

      if (!user) throw new HTTPException(401);
    }

    return c.json(sessions.tokens(user, runtime.tokens));
  });

  app.post('/api/users', async (c) => {
    if (!accounts.setupComplete() || !runtime.config.accounts.allowSelfRegistration) throw new HTTPException(403);

    const input = z
      .object({
        email: z.email(),
        password: z.string().min(1),
        profile: z.object({ firstName: z.string(), lastName: z.string() }),
      })
      .parse(await c.req.json());

    try {
      await accounts.create(`${input.profile.firstName} ${input.profile.lastName}`, input.password, false, input.email);
    } catch {
      throw new HTTPException(400);
    }

    return c.body(null, 200);
  });
  app.post('/api/users/password-reset/', async (c) => {
    const user = authenticated(c);

    const form = c.req.header('Authorization') ? await c.req.parseBody() : await csrf(c, runtime);

    if (user.pass_hash && !(await accounts.verify(user, z.string().catch('').parse(form.current_password))))
      throw new HTTPException(403);
    const password = z.string().min(1).parse(form['password-new']);

    if (password !== form['password-confirm']) throw new HTTPException(400);

    await accounts.changePassword(user.player_id, password);
    sessions.browsers.delete(c.get('browserId'));

    return c.body(null, 204);
  });
  app.get('/logout/:username', (c) => {
    sessions.browsers.delete(c.get('browserId'));

    return c.redirect('/login/');
  });

  app.post('/auth/realms/zwift/protocol/openid-connect/logout', (c) => {
    sessions.browsers.delete(c.get('browserId'));

    return c.body(null, 204);
  });
  app.post('/auth/rb_bf03269xbi', (c) => c.text('OK(Java)'));
}
