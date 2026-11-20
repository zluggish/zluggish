import { BackupService } from '#src/services/backup.service';
import { TlsService } from '#src/services/tls.service';
import { linuxSetupScript, macosSetupScript, setupFileName, windowsSetupScript } from '#src/http/client-setup';
import { AccountsService } from '#src/services/auth.service';
import { ManagementService } from '#src/services/management.service';
import { WebSessionsService } from '#src/services/web-session.service';
import { ActivitiesService } from '#src/services/activities.service';
import { DurabilityService } from '#src/services/durability.service';
import { FilesService } from '#src/services/files.service';
import { effectRoutes } from '#src/http/effect';
import { fileResponse } from '#src/http/file-response';
import { RecordsService } from '#src/services/records.service';
import { webConnectionRoutes } from '#src/http/web-connections';
import { webProfileRoutes } from '#src/http/web-profile';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Context, Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { Effect, Schema } from 'effect';
import { fieldErrors, NumberFromInput, satisfies, Strict } from '#src/schema';
import { ApplicationError, UnreadableCredentialsError } from '#src/errors';
import { credentials, password, newUser } from '#src/dtos/management.dto';
import type { HttpRuntime } from '#src/http/runtime';
import { climbDetails, climbFacts, readClimbProfiles, readClimbSegments, readClimbs } from '#src/http/climbs';
import { peerAddress } from '#src/http/routes/accounts';
import { WORLD_TIME_EPOCH_MS } from '#src/world/state';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { packageRoot, packageVersion, supportedZwiftVersion } from '#src/config/load';

export type WebEnv = { Variables: { sessionId: string; csrf: string } };

/** Matches the public URL exactly, or else the host only: a TLS proxy forwards https requests over http. */
function sameOrigin(origin: string | undefined, url: string, publicUrl: string | null) {
  if (publicUrl) {
    return origin === publicUrl;
  }

  try {
    return !!origin && new URL(origin).host === new URL(url).host;
  } catch {
    return false;
  }
}

export function createWebApp(runtime: HttpRuntime) {
  const app = new Hono<WebEnv>();
  const appRoutes = effectRoutes(app, runtime);
  const accounts = runtime.effects.runSync(AccountsService);
  const management = runtime.effects.runSync(ManagementService);
  const durability = runtime.effects.runSync(DurabilityService);
  const sessions = runtime.effects.runSync(WebSessionsService);
  const attempts = new Map<string, { count: number; until: number }>();
  const cookie = 'zluggish_web_session';
  const csrfCookie = 'zluggish_web_csrf';
  const { publicUrl } = runtime.config.network.web;

  const cookieOptions = (c: Context<WebEnv>) => ({
    httpOnly: true,
    sameSite: 'Lax' as const,
    path: '/',
    secure: new URL(publicUrl ?? c.req.url).protocol === 'https:',
    maxAge: 86_400,
  });

  // A pre-authentication request fails if the caller's session changed while the password work ran.
  const unchanged = (c: Context<WebEnv>) => {
    const id = c.get('sessionId');
    const before = id ? sessions.sessions.get(id) : undefined;

    return () => !id || sessions.sessions.get(id) === before;
  };

  app.use('*', async (c: Context<WebEnv, string>, next: Next) => {
    const upload = c.req.method === 'POST' && c.req.path === '/api/me/import';

    const avatar =
      c.req.method === 'PUT' &&
      (c.req.path === '/api/me/avatar' || /^\/api\/manage\/users\/\d+\/avatar$/.test(c.req.path));

    return bodyLimit({ maxSize: upload ? 81 * 1024 * 1024 : avatar ? 2 * 1024 * 1024 : 64 * 1024 })(c, next);
  });
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    );
    const before = runtime.effects.runSync(durability.changes());
    await next();

    if (runtime.effects.runSync(durability.changes()) !== before) {
      await runtime.effects.runPromise(durability.flush());
    }
  });
  app.get('/health', (c) => c.json({ name: 'zluggish', version: packageVersion(), status: 'ok' }));

  app.use('/api/*', async (c: Context<WebEnv>, next: Next) => {
    // This listener accepts only its own opaque session store. Bearer tokens are never used.
    const id = getCookie(c, cookie);
    const session = runtime.effects.runSync(sessions.find(id));
    let token = session?.csrf ?? getCookie(c, csrfCookie);

    // Anonymous requests get a double-submit token and allocate nothing on the server.
    if (!session && !/^[\w-]{43}$/.test(token ?? '')) {
      token = runtime.effects.runSync(sessions.token());
      setCookie(c, csrfCookie, token, cookieOptions(c));
    }

    c.set('sessionId', session && id ? id : '');
    c.set('csrf', token ?? '');

    if (!['GET', 'HEAD'].includes(c.req.method)) {
      if (!sameOrigin(c.req.header('Origin'), c.req.url, publicUrl) || c.req.header('X-CSRF-Token') !== c.get('csrf')) {
        throw new ApplicationError({ status: 403, message: 'Reload the page and retry.' });
      }

      if (
        !(c.req.method === 'POST' && c.req.path === '/api/me/import'
          ? c.req.header('Content-Type')?.startsWith('multipart/form-data;')
          : c.req.method === 'PUT' &&
              (c.req.path === '/api/me/avatar' || /^\/api\/manage\/users\/\d+\/avatar$/.test(c.req.path))
            ? c.req.header('Content-Type') === 'image/jpeg'
            : c.req.header('Content-Type')?.startsWith('application/json'))
      ) {
        throw new ApplicationError({ status: 400, message: 'JSON required.' });
      }
    }

    if (
      ['/api/setup', '/api/setup/key', '/api/session', '/api/session/confirm'].includes(c.req.path) &&
      c.req.method === 'POST'
    ) {
      const now = Date.now();

      for (const [key, value] of attempts) {
        if (value.until <= now) {
          attempts.delete(key);
        }
      }
      const key = peerAddress(c);
      const limit = attempts.get(key) ?? { count: 0, until: now + 60_000 };

      if (limit.count >= 10 || attempts.size >= 10_000) {
        return c.json({ message: 'Try again shortly.' }, 429);
      }
      limit.count++;
      attempts.set(key, limit);
    }

    await next();
  });

  function login(c: Context<WebEnv>, user: NonNullable<ReturnType<typeof accounts.get>>, confirmed = false) {
    runtime.effects.runSync(sessions.end(c.get('sessionId')));

    const fresh = runtime.effects.runSync(
      sessions.create(accounts.identityOf(user), confirmed ? Date.now() + 900_000 : 0),
    );

    setCookie(c, cookie, fresh.id, cookieOptions(c));

    return c.json({ user: runtime.effects.runSync(management.publicUser(user)), csrf: fresh.session.csrf });
  }

  appRoutes.get('/api/setup', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      return c.json({
        complete: managementService.store.complete(),
        csrf: c.get('csrf'),
        version: packageVersion(),
        zwiftVersion: supportedZwiftVersion(),
      });
    }),
  );
  appRoutes.post('/api/setup', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      const user = yield* managementService.setup(yield* Effect.promise(() => c.req.json()), unchanged(c));

      return login(c, user, true);
    }),
  );
  appRoutes.post('/api/setup/key', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      const input = Schema.decodeUnknownSync(Strict({ key: Schema.String.check(Schema.isMaxLength(200)) }))(
        yield* Effect.promise(() => c.req.json()),
      );

      yield* managementService.checkSetupKey(input.key);

      return c.json({
        users: accounts.list().map(({ player_id, username, first_name, last_name, enabled, pass_hash }) => ({
          player_id,
          username,
          first_name,
          last_name,
          enabled,
          has_password: !!pass_hash,
        })),
      });
    }),
  );
  appRoutes.post('/api/session', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      const input = Schema.decodeUnknownSync(credentials)(yield* Effect.promise(() => c.req.json()));
      const live = unchanged(c);
      const user = yield* managementService.signIn(input.username, input.password);

      if (!live()) {
        throw new ApplicationError({ status: 401, message: 'Session changed.' });
      }

      return login(c, user);
    }),
  );
  appRoutes.delete('/api/session', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      yield* webSessionsService.end(c.get('sessionId'));
      deleteCookie(c, cookie, { path: '/' });

      return c.json({ ok: true });
    }),
  );
  appRoutes.get('/api/me', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      const webSessionsService = yield* WebSessionsService;

      return c.json({
        user: yield* managementService.publicUser(yield* webSessionsService.require(c.get('sessionId'))),
        csrf: c.get('csrf'),
      });
    }),
  );
  appRoutes.post('/api/session/confirm', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      const webSessionsService = yield* WebSessionsService;

      const input = Schema.decodeUnknownSync(Strict({ password }))(yield* Effect.promise(() => c.req.json()));
      yield* managementService.confirm(c.get('sessionId'), input.password);

      return c.json({ confirmedUntil: (yield* webSessionsService.session(c.get('sessionId'))).confirmedUntil });
    }),
  );
  appRoutes.post('/api/me/password', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      const webSessionsService = yield* WebSessionsService;

      const input = Schema.decodeUnknownSync(Strict({ current_password: Schema.optional(password), password }))(
        yield* Effect.promise(() => c.req.json()),
      );

      yield* managementService.changeOwnPassword(c.get('sessionId'), input.current_password, input.password);
      yield* webSessionsService.end(c.get('sessionId'));

      return c.json({ ok: true });
    }),
  );
  appRoutes.get('/api/me/profile', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      return c.json(yield* managementService.ownProfile(c.get('sessionId')));
    }),
  );
  appRoutes.patch('/api/me/profile', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      return c.json(
        yield* managementService.editOwnProfile(c.get('sessionId'), yield* Effect.promise(() => c.req.json())),
      );
    }),
  );
  appRoutes.get('/api/me/avatar', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      const webSessionsService = yield* WebSessionsService;

      const filesService = yield* FilesService;

      const path = yield* managementService.avatarPath(
        (yield* webSessionsService.require(c.get('sessionId'))).player_id,
      );

      if (!(yield* filesService.isFile(path))) {
        throw new ApplicationError({ status: 404, message: 'No photo.' });
      }

      return yield* fileResponse(c, path, { 'Content-Type': 'image/jpeg' });
    }),
  );
  appRoutes.put('/api/me/avatar', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      return c.json(
        yield* managementService.saveAvatar(
          c.get('sessionId'),
          new Uint8Array(yield* Effect.promise(() => c.req.arrayBuffer())),
        ),
      );
    }),
  );
  appRoutes.delete('/api/me/avatar', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      return c.json(yield* managementService.removeAvatar(c.get('sessionId')));
    }),
  );
  appRoutes.get('/api/me/settings', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      const webSessionsService = yield* WebSessionsService;

      return c.json(
        yield* managementService.settings((yield* webSessionsService.require(c.get('sessionId'))).player_id),
      );
    }),
  );
  appRoutes.patch('/api/me/settings', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      const webSessionsService = yield* WebSessionsService;

      const player = (yield* webSessionsService.require(c.get('sessionId'))).player_id;

      return c.json(
        yield* managementService.saveSettings(c.get('sessionId'), player, yield* Effect.promise(() => c.req.json())),
      );
    }),
  );
  webConnectionRoutes(app, runtime);
  webProfileRoutes(app, runtime);

  // Client setup: any rider downloads the certificate and the scripts that install it.
  appRoutes.get('/api/tls', (c) =>
    Effect.gen(function* () {
      const tls = yield* TlsService;
      yield* sessions.require(c.get('sessionId'));

      return c.json(yield* tls.status());
    }),
  );

  /** The certificate that the server presents, without its key. While a server still uses the shared certificate,
  riders can install that one too, with a warning, so that new computers connect until the administrator rotates it.
  */
  const installable = Effect.fn('web.tls.installable')(function* (c: Context<WebEnv>, download: string) {
    const tls = yield* TlsService;
    const user = yield* sessions.require(c.get('sessionId'));
    const status = yield* tls.status();
    const material = tls.material();

    if (status.mode === 'disabled' || !status.certificate || !material) {
      throw new ApplicationError({ status: 409, message: 'This server has no certificate to install.' });
    }

    // A configured file may hold a chain, and the shared one holds its key: take the first certificate only.
    const certificate = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(material.cert)?.[0];

    if (!certificate) {
      throw new ApplicationError({ status: 409, message: 'This server has no certificate to install.' });
    }
    const pem = certificate + '\n';

    if (status.mode === 'legacy') {
      runtime.world.lifecycle.log.warn(
        'tls.legacy_setup_download',
        'A rider downloaded setup for the shared Zwift certificate, whose private key is public. Generate a server certificate under Manage → Server.',
        { player: user.player_id, download },
      );
    }

    return { pem, certificate: status.certificate };
  });

  appRoutes.get('/api/tls/certificate', (c) =>
    Effect.gen(function* () {
      const der = c.req.query('format') === 'der';
      const { pem, certificate } = yield* installable(c, der ? 'certificate.cer' : 'certificate.crt');

      const body = der ? Buffer.from(pem.replaceAll(/-----[A-Z ]+-----|\s/g, ''), 'base64') : Buffer.from(pem, 'utf8');

      return c.body(new Uint8Array(body), 200, {
        'Content-Type': der ? 'application/pkix-cert' : 'application/x-pem-file',
        'Content-Disposition': `attachment; filename="${setupFileName(certificate, der ? 'cer' : 'crt')}"`,
      });
    }),
  );

  const setupAddress = Schema.String.check(
    Schema.isMaxLength(45),
    satisfies((value: string) => value === '' || isIP(value) !== 0, 'Expected an IP address'),
  );

  const setupPlatform = Schema.Literals(['windows', 'linux', 'macos']);

  appRoutes.get('/api/tls/setup/:platform', (c) =>
    Effect.gen(function* () {
      const platform = Schema.decodeUnknownSync(setupPlatform)(c.req.param('platform'));
      const address = Schema.decodeUnknownSync(setupAddress)(c.req.query('address') ?? '');
      const { pem, certificate } = yield* installable(c, `${platform} script`);
      const script = { pem, certificate, address, version: packageVersion(), now: new Date() };

      if (platform === 'windows') {
        return c.body(windowsSetupScript(script), 200, {
          'Content-Type': 'application/x-bat; charset=us-ascii',
          'Content-Disposition': `attachment; filename="${setupFileName(certificate, 'bat')}"`,
        });
      }

      return c.body(platform === 'macos' ? macosSetupScript(script) : linuxSetupScript(script), 200, {
        'Content-Type': 'application/x-sh; charset=us-ascii',
        'Content-Disposition': `attachment; filename="${setupFileName(certificate, 'sh')}"`,
      });
    }),
  );

  const activityId = Schema.String.check(Schema.isPattern(/^\d{1,19}$/));
  appRoutes.get('/api/me/activities', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const activitiesService = yield* ActivitiesService;

      const page = Schema.decodeUnknownSync(
        NumberFromInput.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_000_000)),
      )(c.req.query('page') ?? '0');

      const rows = yield* activitiesService.own(
        (yield* webSessionsService.require(c.get('sessionId'))).player_id,
        undefined,
        page,
      );

      return c.json({ activities: rows.slice(0, 20), hasMore: rows.length > 20 });
    }),
  );
  appRoutes.get('/api/me/climbs', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const recordsService = yield* RecordsService;

      const player = (yield* webSessionsService.require(c.get('sessionId'))).player_id;

      const stats = new Map(
        (yield* recordsService.climbPortalStats(player)).map((row) => [String(row.route_hash), row]),
      );

      const climbs = [];
      const segments = yield* readClimbSegments(runtime);

      const profiles = yield* readClimbProfiles(runtime);
      const all = yield* readClimbs(runtime);

      for (const climb of all) {
        const row = stats.get(climb.road);

        if (!row) {
          continue;
        }

        const facts = climbFacts(climb.name);

        climbs.push({
          road: climb.road,
          ...facts,
          rides: row.rides,
          bestMs: row.best_ms,
          strava: segments[climb.road] ?? null,
          lastRide:
            row.last_world_time === null ? null : new Date(row.last_world_time + WORLD_TIME_EPOCH_MS).toISOString(),
          ...climbDetails(facts, profiles[climb.road]),
        });
      }

      return c.json({ climbs, total: all.length });
    }),
  );
  appRoutes.get('/api/me/activities/:id', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const activitiesService = yield* ActivitiesService;

      return c.json(
        yield* activitiesService.ownDetail(
          (yield* webSessionsService.require(c.get('sessionId'))).player_id,
          Schema.decodeUnknownSync(activityId)(c.req.param('id')),
        ),
      );
    }),
  );
  appRoutes.get('/api/me/activities/:id/fit', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const activitiesService = yield* ActivitiesService;

      const { fit, filename } = yield* activitiesService.ownFit(
        (yield* webSessionsService.require(c.get('sessionId'))).player_id,
        Schema.decodeUnknownSync(activityId)(c.req.param('id')),
      );

      return c.body(new Uint8Array(fit), 200, {
        'Content-Type': 'application/vnd.ant.fit',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });
    }),
  );
  appRoutes.get('/api/me/activities/:id/images/:image', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const activitiesService = yield* ActivitiesService;

      const id = Schema.decodeUnknownSync(activityId)(c.req.param('id'));

      const image = Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(
        c.req.param('image'),
      );

      const path = yield* activitiesService.ownImagePath(
        (yield* webSessionsService.require(c.get('sessionId'))).player_id,
        id,
        image,
      );

      return yield* fileResponse(c, path, {
        'Content-Type': 'image/jpeg',
        ...(c.req.query('download') !== undefined && {
          'Content-Disposition': `attachment; filename="${id}-${image}.jpg"`,
        }),
      });
    }),
  );
  app.use('/api/manage/*', async (c, next) => {
    runtime.effects.runSync(sessions.require(c.get('sessionId'), true));
    await next();
  });
  appRoutes.get('/api/manage/users', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      return c.json({ users: yield* Effect.forEach(accounts.list(), (user) => managementService.publicUser(user)) });
    }),
  );
  appRoutes.post('/api/manage/users', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      const input = Schema.decodeUnknownSync(
        Strict({ operation: Schema.String.check(Schema.isUUID()), user: Schema.Record(Schema.String, Schema.Json) }),
      )(yield* Effect.promise(() => c.req.json()));

      return c.json(
        yield* managementService.create(
          c.get('sessionId'),
          Schema.decodeUnknownSync(newUser)(input.user),
          input.operation,
        ),
        201,
      );
    }),
  );
  appRoutes.get('/api/manage/users/:id', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      const user = accounts.get(
        Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(c.req.param('id')),
      );

      if (!user) {
        throw new ApplicationError({ status: 404, message: 'User not found.' });
      }

      return c.json(yield* managementService.publicUser(user));
    }),
  );

  appRoutes.get('/api/manage/users/:id/profile', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      return c.json(
        yield* managementService.ownProfile(
          c.get('sessionId'),
          Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(c.req.param('id')),
        ),
      );
    }),
  );
  appRoutes.patch('/api/manage/users/:id/profile', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      return c.json(
        yield* managementService.editOwnProfile(
          c.get('sessionId'),
          yield* Effect.promise(() => c.req.json()),
          Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(c.req.param('id')),
        ),
      );
    }),
  );
  appRoutes.put('/api/manage/users/:id/avatar', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      return c.json(
        yield* managementService.saveAvatar(
          c.get('sessionId'),
          new Uint8Array(yield* Effect.promise(() => c.req.arrayBuffer())),
          Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(c.req.param('id')),
        ),
      );
    }),
  );
  appRoutes.delete('/api/manage/users/:id/avatar', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      return c.json(
        yield* managementService.removeAvatar(
          c.get('sessionId'),
          Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(c.req.param('id')),
        ),
      );
    }),
  );

  appRoutes.get('/api/manage/users/:id/avatar', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      const filesService = yield* FilesService;

      const id = Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(
        c.req.param('id'),
      );

      const path = yield* managementService.avatarPath(id);

      if (!accounts.get(id) || !(yield* filesService.isFile(path))) {
        throw new ApplicationError({ status: 404, message: 'No photo.' });
      }

      return yield* fileResponse(c, path, { 'Content-Type': 'image/jpeg' });
    }),
  );

  for (const action of ['password', 'disable', 'enable', 'revoke-sessions', 'role']) {
    appRoutes.on(action === 'role' ? 'PUT' : 'POST', `/api/manage/users/:id/${action}`, (c) =>
      Effect.gen(function* () {
        const managementService = yield* ManagementService;

        return c.json(
          yield* managementService.mutate(
            c.get('sessionId'),
            Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(c.req.param('id')),
            action,
            yield* Effect.promise(() => c.req.json()),
          ),
        );
      }),
    );
  }

  appRoutes.patch('/api/manage/users/:id', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      return c.json(
        yield* managementService.edit(
          c.get('sessionId'),
          Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(c.req.param('id')),
          yield* Effect.promise(() => c.req.json()),
        ),
      );
    }),
  );
  appRoutes.get('/api/manage/users/:id/settings', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      return c.json(
        yield* managementService.settings(
          Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(c.req.param('id')),
        ),
      );
    }),
  );
  appRoutes.patch('/api/manage/users/:id/settings', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      return c.json(
        yield* managementService.saveSettings(
          c.get('sessionId'),
          Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(c.req.param('id')),
          yield* Effect.promise(() => c.req.json()),
          true,
        ),
      );
    }),
  );
  appRoutes.get('/api/manage/settings', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      return c.json({
        configuration: yield* managementService.configuration({
          network: runtime.config.network,
          riderDefaults: runtime.config.riderDefaults,
        }),
        worldSettings: yield* managementService.worldSettings(),
        readOnly: true,
      });
    }),
  );

  const backupOperation = Schema.String.check(Schema.isUUID());

  appRoutes.post('/api/manage/server/backups', (c) =>
    Effect.gen(function* () {
      const input = Schema.decodeUnknownSync(Strict({ operation: backupOperation }))(
        yield* Effect.promise(() => c.req.json()),
      );

      const service = yield* BackupService;
      yield* sessions.require(c.get('sessionId'), true);

      return c.json(yield* service.request(input.operation), 202);
    }),
  );
  appRoutes.get('/api/manage/server/backups/:operation', (c) =>
    Effect.gen(function* () {
      const operation = Schema.decodeUnknownSync(backupOperation)(c.req.param('operation'));
      const service = yield* BackupService;
      const backup = yield* service.status(operation);

      if (!backup) {
        throw new ApplicationError({ status: 404, message: 'Backup request not found.' });
      }

      return c.json(backup);
    }),
  );

  appRoutes.post('/api/manage/server/certificate', (c) =>
    Effect.gen(function* () {
      const input = Schema.decodeUnknownSync(Strict({ operation: backupOperation }))(
        yield* Effect.promise(() => c.req.json()),
      );

      const tls = yield* TlsService;
      yield* sessions.require(c.get('sessionId'), true);

      return c.json(yield* tls.rotate(input.operation));
    }),
  );

  app.get('/api/manage/server/logs', (c) => c.json({ entries: runtime.world.lifecycle.log.recentEntries() }));

  for (const action of ['reload-bots', 'bots']) {
    appRoutes.post(`/api/manage/server/${action}`, (c) =>
      Effect.gen(function* () {
        const managementService = yield* ManagementService;

        return c.json(
          yield* managementService.serverOperation(
            c.get('sessionId'),
            action,
            yield* Effect.promise(() => c.req.json()),
            () => runtime.effects.runPromise(durability.flush()),
            {
              reload: async () => {
                await runtime.world.simulation?.reload();
              },
              bots: (user, command) =>
                runtime.world.simulation?.command(BigInt(user), command, true) ?? 'Bots are not running.',
            },
          ),
        );
      }),
    );
  }

  appRoutes.patch('/api/manage/settings', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      return c.json(yield* managementService.saveWorld(c.get('sessionId'), yield* Effect.promise(() => c.req.json())));
    }),
  );
  appRoutes.get('/api/manage/events', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      return c.json({ events: yield* managementService.events() });
    }),
  );
  appRoutes.on(['PATCH', 'DELETE'], '/api/manage/events/:id', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      return c.json(
        yield* managementService.editEvent(
          c.get('sessionId'),
          Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(c.req.param('id')),
          c.req.method === 'DELETE' ? 'delete-event' : 'edit-event',
          yield* Effect.promise(() => c.req.json()),
        ),
      );
    }),
  );
  const clientRoot = resolve(packageRoot(), '../web/dist/app');
  appRoutes.get('/assets/:file', (c) =>
    Effect.gen(function* () {
      const filesService = yield* FilesService;

      const name = c.req.param('file');

      if (!/^[\w.-]+\.(?:js|css|woff2|png|jpg|svg)$/.test(name)) {
        return c.notFound();
      }
      const path = resolve(clientRoot, 'assets', name);

      if (!(yield* filesService.isFile(path))) {
        return c.notFound();
      }
      const ext = name.slice(name.lastIndexOf('.') + 1);

      const types = {
        js: 'text/javascript',
        css: 'text/css',
        woff2: 'font/woff2',
        png: 'image/png',
        jpg: 'image/jpeg',
        svg: 'image/svg+xml',
      };

      // SAFETY: the filename extension was restricted to these MIME types above.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return yield* fileResponse(c, path, { 'Content-Type': types[ext as keyof typeof types] });
    }),
  );

  for (const path of [
    '/',
    '/setup',
    '/sign-in',
    '/settings',
    '/profile/:id',
    '/integrations',
    '/import',
    '/import/*',
    '/export',
    '/zwift',
    '/activities',
    '/activities/*',
    '/climbs',
    '/install',
    '/install/*',
    '/manage',
    '/manage/*',
  ]) {
    appRoutes.get(path, (c) =>
      Effect.gen(function* () {
        const filesService = yield* FilesService;

        const index = resolve(clientRoot, 'index.html');

        return (yield* filesService.exists(index))
          ? c.html(yield* filesService.readText(index))
          : c.text('Build the web app before starting.', 503);
      }),
    );
  }
  app.onError((error, c) => {
    if (Schema.isSchemaError(error)) {
      return c.json({ message: 'Check the form fields.', fieldErrors: fieldErrors(error) }, 400);
    }

    if (error instanceof HTTPException) {
      return c.json({ message: error.message }, error.status);
    }

    if (error instanceof ApplicationError) {
      return c.json({ message: error.message }, error.status);
    }

    const route = c.req.routePath === '*' ? 'unmatched' : c.req.routePath;

    if (error instanceof UnreadableCredentialsError) {
      runtime.world.lifecycle.log.warn('connections.unreadable', 'Saved credentials cannot be decrypted', {
        method: c.req.method,
        route,
        error,
      });

      return c.json({ message: 'The saved credentials cannot be read. Enter them again in Integrations.' }, 409);
    }

    runtime.world.lifecycle.log.error('web.failed', 'Web request failed unexpectedly', {
      method: c.req.method,
      route,
      error: error instanceof Error ? error : String(error),
    });

    return c.json({ message: 'The server hit an unexpected error. The server log has the details.' }, 500);
  });

  return app;
}
