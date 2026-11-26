import { t } from '#src/i18n/index';
import { RuntimeContext } from '#src/context';
import { ApplicationError } from '#src/errors';
import { Context, Effect, Layer, Schema } from 'effect';

export interface WebSession {
  csrf: string;
  identity: string;
  expires: number;
  confirmedUntil: number;
  pendingImport?: string;
  stravaState?: string;
}

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const repositories = context.accounts.repositories;
  const { accounts } = context;

  const sessions = new Map<string, WebSession>();

  function token() {
    return repositories.cryptoRepository.randomBytes(32).toString('base64url');
  }

  function hash(id: string) {
    return repositories.cryptoRepository.sha256(id);
  }

  /** A restart empties the map; a session found in the database is loaded back into it. */
  function restore(id: string) {
    const row = Schema.decodeUnknownSync(
      Schema.NullOr(Schema.Struct({ csrf: Schema.String, identity: Schema.String, expires: Schema.Finite })),
    )(accounts.db.prepare('SELECT csrf, identity, expires FROM web_session WHERE id_hash = ?').get(hash(id)) ?? null);

    if (!row) {
      return;
    }
    const session: WebSession = { ...row, confirmedUntil: 0 };
    sessions.set(id, session);

    return session;
  }

  function find(id: string | undefined) {
    if (!id) {
      return null;
    }
    const session = sessions.get(id) ?? restore(id);

    if (!session) {
      return null;
    }

    if (session.expires <= Date.now()) {
      end(id);

      return null;
    }

    return session;
  }

  function create(identity: string, confirmedUntil = 0) {
    const now = Date.now();

    for (const [key, value] of sessions) {
      if (value.expires <= now) {
        sessions.delete(key);
      }
    }
    accounts.db.prepare('DELETE FROM web_session WHERE expires <= ?').run(now);

    if (sessions.size >= 10_000) {
      throw new ApplicationError({ status: 503, message: t('too_many_web_sessions') });
    }
    const id = token();
    const session: WebSession = { csrf: token(), identity, expires: now + 86_400_000, confirmedUntil };
    sessions.set(id, session);
    accounts.db
      .prepare('INSERT INTO web_session (id_hash, csrf, identity, expires) VALUES (?, ?, ?, ?)')
      .run(hash(id), session.csrf, identity, session.expires);

    return { id, session };
  }

  function end(id: string) {
    sessions.delete(id);

    if (id) {
      accounts.db.prepare('DELETE FROM web_session WHERE id_hash = ?').run(hash(id));
    }
  }

  function userNow(id: string) {
    const session = find(id);

    if (!session) {
      return null;
    }
    const user = accounts.identity(session.identity);

    // An identity change (password, role, enabled state, revocation) ends the session and its confirmation.
    if (!user) {
      end(id);
    }

    return user;
  }

  function requireUser(id: string, manage = false, _confirm = true) {
    const user = userNow(id);

    if (!user) {
      throw new ApplicationError({ status: 401, message: t('sign_in_again') });
    }

    if (manage && user.role !== 'administrator') {
      throw new ApplicationError({ status: 403, message: t('administrator_role_required') });
    }

    return user;
  }

  function current(id: string, identity: string) {
    return !!userNow(id) && sessions.get(id)?.identity === identity;
  }

  return {
    sessions,

    token: Effect.fn('WebSessionsService.token')(function* () {
      return token();
    }),

    find: Effect.fn('WebSessionsService.find')(function* (id: string | undefined) {
      return find(id);
    }),

    session: Effect.fn('WebSessionsService.session')(function* (id: string) {
      const session = find(id);

      if (!session) {
        throw new ApplicationError({ status: 401, message: t('sign_in_again') });
      }

      return session;
    }),

    create: Effect.fn('WebSessionsService.create')(function* (identity: string, confirmedUntil: number = 0) {
      return create(identity, confirmedUntil);
    }),

    end: Effect.fn('WebSessionsService.end')(function* (id: string) {
      return end(id);
    }),

    user: Effect.fn('WebSessionsService.user')(function* (id: string) {
      return userNow(id);
    }),

    require: Effect.fn('WebSessionsService.require')(function* (
      id: string,
      manage: boolean = false,
      _confirm: boolean = true,
    ) {
      return requireUser(id, manage, _confirm);
    }),

    current: Effect.fn('WebSessionsService.current')(function* (id: string, identity: string) {
      return current(id, identity);
    }),
  };
});

/** Only signed-in users hold server state. Anonymous requests use a double-submit CSRF
cookie, so requests without cookies cannot fill this store.
*/
export class WebSessionsService extends Context.Service<WebSessionsService, Effect.Success<typeof make>>()(
  'zluggish/WebSessionsService',
) {
  static readonly layer = Layer.effect(WebSessionsService, make);
}
