import { t } from '#src/i18n/index';
import { PasswordLimits } from '#src/http/password-limits';
import { AccountsService } from '#src/services/auth.service';
import { WorkoutsService } from '#src/services/workout.service';
import { FilesService } from '#src/services/files.service';
import { ProfilesService } from '#src/services/profile.service';
import { effectRoutes } from '#src/http/effect';
import { RecordsService } from '#src/services/records.service';
import { calendarLabels, mapChoices } from '#src/http/game/calendar';
import { checkbox, field, form as makeForm, hidden, model } from '#src/http/game/models';
import { gamePage } from '#src/http/game/render';
import { browserJson, gameRedirect } from '#src/http/game/results';
import { readClimbs } from '#src/http/climbs';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import type { User } from '#src/repositories/accounts.repository';
import { REMEMBER_SECONDS, SessionsService } from '#src/services/browser-session.service';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, Hono, Next } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { resolve } from 'node:path';
import { Effect, Option, Schema } from 'effect';
import { orElse, PositiveIntFromString } from '#src/schema';

export function authenticated(c: Context<RuntimeEnv>) {
  const rider = c.get('user');

  if (!rider) {
    throw new HTTPException(401);
  }

  return rider;
}

function riderName(user: { first_name: string; last_name: string }) {
  return `${user.first_name} ${user.last_name}`.trim();
}

function rememberCookie(playerId: number) {
  return `zluggish_remember_${playerId}`;
}

// The password step after choosing a rider this computer does not remember.
function unlockPage(c: Context<RuntimeEnv>, user: User, error = '') {
  return model(
    c,
    'unlock',
    riderName(user),
    [
      makeForm(
        'unlock',
        '/login/',
        [
          hidden('player_id', String(user.player_id)),
          hidden('step', 'password'),
          field('password', t('password'), {
            type: 'password',
            required: true,
            autocomplete: 'current-password',
            autofocus: true,
          }),
          checkbox('remember', t('remember_password')),
        ],
        t('sign_in'),
        { primary: true, transient: true },
      ),
    ],
    {
      message: error,
      failed: !!error,
      back: { href: '/login/', label: t('user_select_alternative') },
    },
  );
}

type FormFields = Readonly<Record<string, string | File | ReadonlyArray<string | File>>>;

export async function csrf(c: Context<RuntimeEnv>, runtime: Runtime): Promise<FormFields> {
  const form = await c.req.parseBody();

  if (
    !runtime.effects
      .runSync(SessionsService)
      .validCsrf(c.get('browser'), Schema.decodeUnknownSync(Schema.String.pipe(orElse('')))(form.csrf_token))
  ) {
    throw new HTTPException(400, {
      message: t('accounts_form_expired'),
    });
  }

  return Schema.decodeUnknownSync(
    Schema.Record(
      Schema.String,
      Schema.Union([
        Schema.String,
        Schema.instanceOf(File),
        Schema.Array(Schema.Union([Schema.String, Schema.instanceOf(File)])),
      ]),
    ),
  )(form);
}

export function peerAddress(c: Context) {
  try {
    return getConnInfo(c).remote.address ?? '';
  } catch {
    return '';
  }
}

export function accountRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const accounts = runtime.effects.runSync(AccountsService);
  const sessions = runtime.effects.runSync(SessionsService);
  const { world } = runtime;
  const passwordLimits = new PasswordLimits();

  async function verifyPassword(c: Context<RuntimeEnv>, user: User | null, password: string) {
    const release = passwordLimits.acquire(peerAddress(c), user?.player_id);

    if (!release) {
      c.header('Retry-After', '60');
      const message = t('accounts_password_rate_limit');

      throw new HTTPException(429, { message, res: c.text(message, 429) });
    }
    try {
      return user ? await accounts.verify(user, password) : false;
    } finally {
      release();
    }
  }
  app.use('*', async (c: Context<RuntimeEnv>, next: Next) => {
    const authorization = c.req.header('Authorization');
    const existing = getCookie(c, 'zluggish_session');

    const browserPage =
      !/^\/(?:api|relay|health|download|uploads|style|static|mochi|gameassets|experimentation|live-segment-results-service|player-playback)(?:\/|$)/.test(
        c.req.path,
      );

    const passive = c.req.path.startsWith('/ui/status/');
    const previous = existing ? sessions.browsers.get(existing) : undefined;
    const live = previous !== undefined && Date.now() - previous.touched <= 86_400_000;

    const persistent =
      !authorization &&
      !c.req.path.startsWith('/static/launcher-ui/') &&
      (passive ? live : browserPage || (existing !== undefined && sessions.browsers.has(existing)));

    const opened = persistent
      ? sessions.open(existing)
      : {
          id: '',
          session: {
            csrf: '',
            identity: null,
            selected: false,
            touched: Date.now(),
          },
        };

    c.set('browser', opened.session);
    c.set('browserId', opened.id);

    if (persistent && existing !== opened.id) {
      setCookie(c, 'zluggish_session', opened.id, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: c.req.url.startsWith('https:'),
        path: '/',
        maxAge: 86_400,
      });
    }
    c.set(
      'user',
      authorization ? sessions.bearer(authorization.replace(/^Bearer /i, '')) : sessions.user(opened.session),
    );

    if (authorization && !c.get('user')) {
      throw new HTTPException(401);
    }

    if (browserPage || browserJson(c)) {
      c.header('Cache-Control', 'no-store');
    }
    const context = c.req.header('X-Game-Context');

    if (browserJson(c) && context && context !== c.get('browser').csrf) {
      throw new HTTPException(c.get('user') ? 409 : 401, {
        message: t('accounts_session_changed'),
      });
    }
    await next();
  });

  app.get('/', (c) => gameRedirect(c, '/login/'));
  // Only an administrator creates users, in the web app. Every old registration path says so.
  app.on(
    ['GET', 'POST'],
    [
      '/signup/',
      '/riders/add/',
      '/launcher/realms/zwift/protocol/openid-connect/registrations',
      '/auth/realms/zwift/protocol/openid-connect/registrations',
      '/auth/realms/zwift/tokens/registrations',
    ],
    (c) => {
      c.status(403);

      return runtime.effects.runPromise(
        gamePage(
          c,
          model(c, 'message', t('registration_unavailable'), [], {
            message: t('accounts_registration_unavailable'),
            failed: true,
            errorStatus: 403,
            back: { href: '/login/', label: t('user_select_placeholder') },
          }),
        ),
      );
    },
  );

  function loginPage(c: Context<RuntimeEnv>, error = '') {
    return model(
      c,
      'login',
      t('who_s_riding'),
      accounts
        .list()
        .filter((user) => user.enabled)
        .map((user) =>
          makeForm(
            `rider-${user.player_id}`,
            '/login/',
            [hidden('player_id', String(user.player_id))],
            riderName(user),
            {
              user: {
                initials: `${user.first_name.charAt(0)}${user.last_name.charAt(0)}`.toUpperCase(),
                photo: runtime.effects.runSync(
                  Effect.flatMap(
                    ProfilesService.use((service) => service.folder(user.player_id)),
                    (folder) => FilesService.use((files) => files.exists(resolve(folder, 'avatarLarge.jpg'))),
                  ),
                )
                  ? `/download/${user.player_id}/avatarLarge.jpg`
                  : null,
                // Riders created without an email get a placeholder username that means nothing to people.
                email: user.username.endsWith('@local.invalid') ? null : user.username,
                workout: (() => {
                  try {
                    const [planned] = runtime.effects.runSync(
                      WorkoutsService.use((service) => service.today(user.player_id)),
                    ).workouts;

                    return planned
                      ? { name: planned.name, minutes: Math.round(planned.summary.durationSeconds / 60) }
                      : null;
                  } catch {
                    // A broken workout store must never hide the rider list.
                    return null;
                  }
                })(),
              },
            },
          ),
        ),
      {
        message: error || (accounts.list().some((user) => user.enabled) ? '' : t('accounts_users_unavailable')),
        failed: !!error,
      },
    );
  }

  app.on(['GET', 'POST'], '/login/', async (c) => {
    const session = c.get('browser');
    sessions.transition(session, { type: 'clear-selection' });

    let error = '';

    if (c.req.method === 'POST') {
      const form = await csrf(c, runtime);

      const id = Schema.decodeUnknownOption(PositiveIntFromString)(form.player_id);

      const user = Option.isSome(id) ? accounts.get(id.value) : null;
      const password = Schema.decodeUnknownSync(Schema.String.pipe(orElse('')))(form.password);
      const step = form.step === 'password';
      let signedIn: User | null = null;

      // Only riders migrated from legacy password hashes lack a password; they cannot sign in until it is set.
      if (user && !user.pass_hash) {
        runtime.world.lifecycle.log.warn(
          'auth.login_no_password',
          t('login_without_password', { value1: user.player_id, value2: riderName(user) }),
          { playerId: user.player_id },
        );

        return runtime.effects.runPromise(gamePage(c, loginPage(c, t('login_failed'))));
      }

      if (user && !step) {
        signedIn = sessions.remembered(getCookie(c, rememberCookie(user.player_id)) ?? '', user.player_id);

        if (!signedIn) {
          return runtime.effects.runPromise(gamePage(c, unlockPage(c, user)));
        }
      } else if (await verifyPassword(c, user, password)) {
        signedIn = user;
      }

      if (signedIn) {
        const user = signedIn;

        if (!accounts.identity(accounts.identityOf(user))) {
          throw new HTTPException(401);
        }

        if (sessions.browsers.get(c.get('browserId')) !== session) {
          throw new HTTPException(401);
        }
        const secure = c.req.url.startsWith('https:');

        // Set before the session cookie: clients and tests read the session from the last Set-Cookie header.
        if (!step || form.remember === 'on') {
          setCookie(c, rememberCookie(user.player_id), sessions.remember(user), {
            httpOnly: true,
            sameSite: 'Strict',
            secure,
            path: '/login/',
            maxAge: REMEMBER_SECONDS,
          });
        } else {
          deleteCookie(c, rememberCookie(user.player_id), { path: '/login/' });
        }
        sessions.end(c.get('browserId'));
        const fresh = sessions.open();
        sessions.transition(fresh.session, {
          type: 'login',
          identity: runtime.effects.runSync(AccountsService).identityOf(user),
        });
        setCookie(c, 'zluggish_session', fresh.id, {
          httpOnly: true,
          sameSite: 'Lax',
          secure: c.req.url.startsWith('https:'),
          path: '/',
          maxAge: 86_400,
        });

        runtime.world.lifecycle.log.info('auth.login_succeeded', 'User logged in', {
          playerId: user.player_id,
          flow: 'browser',
        });

        return gameRedirect(c, `/user/${encodeURIComponent(user.username)}/`);
      }

      if (user && step) {
        runtime.world.lifecycle.log.warn(
          'auth.login_failed',
          `Login failed: wrong password for rider ${user.player_id} (${riderName(user)})`,
          { playerId: user.player_id, flow: 'browser' },
        );

        return runtime.effects.runPromise(gamePage(c, unlockPage(c, user, t('wrong_password_try_again'))));
      }

      runtime.world.lifecycle.log.warn('auth.login_failed', 'Login failed: unknown rider', { flow: 'browser' });
      error = t('accounts_user_not_found');
    }

    return runtime.effects.runPromise(gamePage(c, loginPage(c, error)));
  });

  app.post('/riders/switch/', async (c) => {
    await csrf(c, runtime);
    sessions.end(c.get('browserId'));
    deleteCookie(c, 'zluggish_session', { path: '/' });

    return gameRedirect(c, '/login/');
  });

  const appRoutes = effectRoutes(app, runtime);
  appRoutes.get('/user/:username/', (c) =>
    Effect.gen(function* () {
      const workoutsService = yield* WorkoutsService;

      const filesService = yield* FilesService;

      const recordsService = yield* RecordsService;

      const user = authenticated(c);
      yield* workoutsService.syncWorkoutsAutomatically(user.player_id);

      const climbs = yield* readClimbs(runtime);

      const ridden = new Set(yield* recordsService.riddenClimbRoads(user.player_id));

      const calendar = calendarLabels(
        yield* filesService.readText(resolve(runtime.assets, 'cdn/gameassets/MapSchedule_v2.xml')),
        yield* filesService.readText(resolve(runtime.assets, 'cdn/gameassets/PortalRoadSchedule_v1.xml')),
        climbs,
      );

      return yield* Effect.suspend(() =>
        gamePage(
          c,
          model(c, 'dashboard', t('value_pair', { value1: user.first_name, value2: user.last_name }), [
            makeForm(
              'launch',
              '/start-zwift',
              [
                field('map', t('map'), {
                  type: 'select',
                  value: 'CALENDAR',
                  options: [
                    { value: 'CALENDAR', label: calendar.map },
                    ...mapChoices.map(({ value, label }) => ({ value, label })),
                  ],
                }),
                field('climb', t('climb'), {
                  type: 'select',
                  value: 'CALENDAR',
                  options: [
                    { value: 'CALENDAR', label: calendar.climb },
                    ...climbs.map((climb) => ({
                      value: climb.road,
                      label: ridden.has(climb.road) ? `✓ ${climb.name}` : climb.name,
                    })),
                  ],
                }),
              ],
              t('start_zwift'),
              { navigation: true, primary: true },
            ),
            makeForm('switch', '/riders/switch/', [], t('switch_rider')),
          ]),
        ),
      );
    }),
  );

  app.get('/ui/status/session', (c) => {
    if (!c.get('browserId')) {
      throw new HTTPException(401);
    }
    c.header('Cache-Control', 'no-store');

    return c.body(null, 204);
  });

  const launchAliases = [
    '/launcher',
    '/launcher/ride',
    '/launcher/realms/zwift/protocol/openid-connect/auth',
    '/auth/realms/zwift/protocol/openid-connect/auth',
    '/auth/realms/zwift/login-actions/request/login',
    '/auth/realms/zwift/login-actions/startriding',
    '/auth/realms/zwift/tokens/login',
    '/ride',
  ];

  app.on(['GET', 'POST'], launchAliases, (c) => {
    const user = c.get('user');

    if (c.req.path !== '/ride' || !user || !c.get('browser').selected) {
      sessions.transition(c.get('browser'), { type: 'clear-selection' });

      return c.redirect('/login/');
    }

    if (world.active(user.player_id)) {
      throw new HTTPException(409);
    }

    return c.redirect(
      `http://zwift/?code=zwift_refresh_token${sessions.token(runtime.effects.runSync(AccountsService).identityOf(user), runtime.tokens.refresh, 'refresh')}`,
    );
  });

  app.post('/start-zwift', async (c) => {
    const user = authenticated(c);
    const form = await csrf(c, runtime);

    if (!c.get('browser').selected) {
      return c.redirect('/login/');
    }

    if (world.active(user.player_id)) {
      throw new HTTPException(409);
    }

    const address = peerAddress(c);

    if (form.map && form.map !== 'CALENDAR') {
      world.mapOverrides.set(address, Schema.decodeUnknownSync(Schema.String)(form.map));
    } else if (form.map === 'CALENDAR') {
      world.mapOverrides.delete(address);
    }

    if (form.climb && form.climb !== 'CALENDAR') {
      world.climbOverrides.set(address, Schema.decodeUnknownSync(Schema.String)(form.climb));
    } else if (form.climb === 'CALENDAR') {
      world.climbOverrides.delete(address);
    }

    return c.redirect('/ride');
  });

  app.post('/auth/realms/zwift/protocol/openid-connect/token', async (c) => {
    const form = await c.req.parseBody();
    let user;

    if (form.username) {
      user = accounts.byUsername(Schema.decodeUnknownSync(Schema.String)(form.username));

      const valid = await verifyPassword(
        c,
        user,
        Schema.decodeUnknownSync(Schema.String.pipe(orElse('')))(form.password),
      );

      if (!user || !valid) {
        runtime.world.lifecycle.diagnostic('auth.login_failed', t('login_rejected'), true);
        throw new HTTPException(401);
      }
    } else {
      const token = form.code
        ? Schema.decodeUnknownSync(Schema.String)(form.code)
        : Schema.decodeUnknownSync(Schema.String)(form.refresh_token);

      if (form.code && !token.startsWith('zwift_refresh_token')) {
        throw new HTTPException(401);
      }

      user = sessions.bearer(form.code ? token.slice(19) : token, 'refresh');

      if (!user) {
        throw new HTTPException(401);
      }
    }

    const result = sessions.tokens(user, runtime.tokens);

    if (form.username) {
      runtime.world.lifecycle.log.info('auth.login_succeeded', 'User logged in', {
        playerId: user.player_id,
        flow: 'credentials',
      });
    } else {
      runtime.world.lifecycle.log.verbose('auth.token_exchanged', t('authentication_token_exchanged'), {
        playerId: user.player_id,
      });
    }

    return c.json(result);
  });

  app.post('/api/users', (c) => c.text(t('registration_unavailable'), 403));
  app.post('/api/users/password-reset/', async (c) => {
    const user = authenticated(c);

    const form = c.req.header('Authorization') ? await c.req.parseBody() : await csrf(c, runtime);

    if (
      user.pass_hash &&
      !(await accounts.verify(user, Schema.decodeUnknownSync(Schema.String.pipe(orElse('')))(form.current_password)))
    ) {
      throw new HTTPException(403);
    }
    const password = Schema.decodeUnknownSync(Schema.String.check(Schema.isMinLength(1)))(form['password-new']);

    if (password !== form['password-confirm']) {
      throw new HTTPException(400);
    }

    await accounts.changePassword(
      user.player_id,
      password,
      false,
      () =>
        !!accounts.identity(accounts.identityOf(user)) &&
        (!c.get('browserId') || sessions.current(c.get('browserId'), c.get('browser'), accounts.identityOf(user))),
    );
    sessions.end(c.get('browserId'));

    return c.body(null, 204);
  });
  app.get('/logout/:username', (c) => {
    const user = c.get('user');

    if (user) {
      runtime.world.lifecycle.log.info('auth.logout', 'User logged out', { playerId: user.player_id });
    }
    sessions.end(c.get('browserId'));

    return c.redirect('/login/');
  });

  app.post('/auth/realms/zwift/protocol/openid-connect/logout', (c) => {
    sessions.end(c.get('browserId'));

    return c.body(null, 204);
  });
  app.post('/auth/rb_bf03269xbi', (c) => c.text('OK(Java)'));
}
