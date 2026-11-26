import { t } from '#src/i18n/index';
import { ApplicationError } from '#src/errors';
import type { User } from '#src/repositories/accounts.repository';
import type { AccountsService } from '#src/services/auth.service';
import { resolve } from 'node:path';
import { Context, Schema } from 'effect';

export interface BrowserSession {
  csrf: string;
  identity: string | null;
  selected: boolean;
  touched: number;
}

type BrowserEvent = { type: 'login'; identity: string } | { type: 'clear-selection' };

const identityPayload = Schema.Struct({
  session_cookie: Schema.String,
  exp: Schema.Number,
  iat: Schema.Number,
  typ: Schema.String,
});

type TokenPurpose = 'access' | 'refresh';
export const ACCESS_SECONDS = 6 * 3600;
export const REFRESH_SECONDS = 90 * 86_400;

export const REMEMBER_SECONDS = 90 * 86_400;

export interface OpenedSession {
  id: string;
  session: BrowserSession;
}

/** The launcher's browser sessions for an account database. Tokens are signed with the storage
folder's secret key, created on first use.
*/
function openSessions(accounts: AccountsService['Service']) {
  const repositories = accounts.repositories;
  const browsers = new Map<string, BrowserSession>();
  let secret: Buffer;
  const path = resolve(accounts.storage, 'secret-key.txt');

  if (repositories.filesRepository.existsSync(path)) {
    secret = repositories.filesRepository.readFileSync(path);
  } else {
    secret = repositories.cryptoRepository.randomBytes(32);
    repositories.filesRepository.writeDurable(path, secret);
  }

  function open(id?: string): OpenedSession {
    const now = Date.now();

    // Map insertion order tracks last use. Reclaim only a bounded batch per request;
    // never displace a live sign-in (anonymous sessions also hold CSRF state).
    for (let reclaimed = 0; reclaimed < 64; reclaimed++) {
      const oldest = browsers.entries().next().value;

      if (!oldest || now - oldest[1].touched <= 86_400_000) {
        break;
      }
      end(oldest[0]);
    }
    const previous = id ? browsers.get(id) : undefined;

    if (id && previous) {
      end(id);

      if (now - previous.touched <= 86_400_000) {
        previous.touched = now;
        browsers.set(id, previous);

        return { id, session: previous };
      }
    }

    if (browsers.size >= 10_000) {
      throw new ApplicationError({ status: 503, message: t('too_many_browser_sessions') });
    }

    const token = repositories.cryptoRepository.randomBytes(32).toString('base64url');

    const session: BrowserSession = {
      csrf: repositories.cryptoRepository.randomBytes(32).toString('base64url'),
      identity: null,
      selected: false,
      touched: now,
    };

    browsers.set(token, session);

    return { id: token, session };
  }

  /** Identity and launch selection are independent session dimensions. */
  function transition(session: BrowserSession, event: BrowserEvent) {
    switch (event.type) {
      case 'login': {
        session.identity = event.identity;
        session.selected = true;
        break;
      }

      case 'clear-selection': {
        session.selected = false;
        break;
      }
    }
  }

  function end(id: string) {
    browsers.delete(id);
  }

  /** Recheck after awaits: logout, eviction or password change invalidates continuation. */
  function current(id: string, session: BrowserSession, identity: string) {
    return browsers.get(id) === session && session.identity === identity && !!accounts.identity(identity);
  }

  function validCsrf(session: BrowserSession, token: string) {
    if (!session.csrf) {
      return false;
    }
    const expected = Buffer.from(session.csrf);
    const supplied = Buffer.from(token);

    return supplied.length === expected.length && repositories.cryptoRepository.timingSafeEqual(expected, supplied);
  }

  /** A signed "remember password" token for one rider; a password change bumps auth_version and revokes it. */
  function remember(rider: User, now = Date.now()) {
    const expires = Math.floor(now / 1000) + REMEMBER_SECONDS;

    return repositories.cryptoRepository.signIdentity(`remember:${accounts.identityOf(rider)}:${expires}`, secret);
  }

  function remembered(token: string, playerId: number, now = Date.now()) {
    const match = /^remember:(\d+:\d+):(\d+)$/.exec(repositories.cryptoRepository.verifyIdentity(token, secret) ?? '');

    if (!match?.[1] || Number(match[2]) * 1000 < now) {
      return null;
    }
    const rider = accounts.identity(match[1]);

    return rider?.player_id === playerId ? rider : null;
  }

  function user(session: BrowserSession) {
    return session.identity ? accounts.identity(session.identity) : null;
  }

  function bearer(token: string, purpose: TokenPurpose = 'access', now = Date.now()) {
    const payload = token.split('.', 2)[1];

    if (!payload) {
      return null;
    }

    try {
      const parsed = Schema.decodeUnknownSync(identityPayload)(
        JSON.parse(Buffer.from(payload, 'base64url').toString()),
      );

      // The outer JWT uses Zwift's public "nosecret" key. Only the inner signature is authoritative.
      const claims = repositories.cryptoRepository.verifyIdentity(parsed.session_cookie, secret) ?? '';
      const match = /^game-v1:(access|refresh):(\d+:\d+):(\d+):(\d+)$/.exec(claims);

      if (!match) {
        return null;
      }
      const [, signedPurpose, identity, issued, expires] = match;
      const iat = Number(issued);
      const exp = Number(expires);

      if (
        signedPurpose !== purpose ||
        !Number.isSafeInteger(iat) ||
        !Number.isSafeInteger(exp) ||
        exp <= iat ||
        now < iat * 1000 ||
        now >= exp * 1000 ||
        parsed.iat !== iat ||
        parsed.exp !== exp ||
        parsed.typ !== (purpose === 'access' ? t('bearer') : t('refresh'))
      ) {
        return null;
      }

      return identity ? accounts.identity(identity) : null;
    } catch {
      return null;
    }
  }

  function token(identity: string, template: string, purpose: TokenPurpose, now = Date.now()) {
    const iat = Math.floor(now / 1000);
    const exp = iat + (purpose === 'access' ? ACCESS_SECONDS : REFRESH_SECONDS);
    const values = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
      Buffer.from(template.split('.', 2)[1] ?? '', 'base64url').toString(),
    );

    const body = Buffer.from(
      JSON.stringify({
        ...values,
        iat,
        exp,
        nbf: iat,
        typ: purpose === 'access' ? t('bearer') : t('refresh'),
        session_cookie: repositories.cryptoRepository.signIdentity(
          `game-v1:${purpose}:${identity}:${iat}:${exp}`,
          secret,
        ),
      }),
    ).toString('base64url');

    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

    const signature = repositories.cryptoRepository.signToken(`${header}.${body}`);

    return `${header}.${body}.${signature}`;
  }

  function tokens(
    rider: NonNullable<ReturnType<AccountsService['Service']['get']>>,
    templates: { access: string; refresh: string; id: string },
  ) {
    const identity = accounts.identityOf(rider);

    if (!accounts.identity(identity)) {
      throw new ApplicationError({ status: 401, message: t('browser_session_account_changed') });
    }

    const now = Date.now();

    return {
      access_token: token(identity, templates.access, 'access', now),
      expires_in: ACCESS_SECONDS,
      refresh_expires_in: REFRESH_SECONDS,
      refresh_token: token(identity, templates.refresh, 'refresh', now),
      token_type: 'bearer',
      id_token: templates.id,
      'not-before-policy': 1_408_478_984,
      session_state: '0846ab9a-765d-4c3f-a20c-6cac9e86e5f3',
      scope: '',
    };
  }

  return {
    secret,
    browsers,
    accounts,
    open,
    transition,
    end,
    current,
    validCsrf,
    remember,
    remembered,
    user,
    bearer,
    token,
    tokens,
  };
}

export class SessionsService extends Context.Service<SessionsService, ReturnType<typeof openSessions>>()(
  'zluggish/SessionsService',
) {
  static readonly open = openSessions;
}
