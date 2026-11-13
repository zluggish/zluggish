import { ApplicationError } from '#src/errors';
import { AccountsService, identityOf } from '#src/services/auth.service';
import { writeDurable, existsSync, readFileSync } from '#src/repositories/files.repository';
import {
  signIdentity,
  verifyIdentity,
  signToken,
  randomBytes,
  timingSafeEqual,
} from '#src/repositories/crypto.repository';
import { resolve } from 'node:path';
import { z } from 'zod';

export interface BrowserSession {
  csrf: string;
  identity: string | null;
  selected: boolean;
  pendingImport: string | null;
  touched: number;
}

const identityPayload = z.object({ session_cookie: z.string() });

export interface OpenedSession {
  id: string;
  session: BrowserSession;
}

export class SessionsService {
  readonly secret: Buffer;
  readonly browsers = new Map<string, BrowserSession>();

  constructor(readonly accounts: AccountsService) {
    const path = resolve(accounts.storage, 'secret-key.txt');

    if (existsSync(path)) this.secret = readFileSync(path);
    else {
      this.secret = randomBytes(32);
      writeDurable(path, this.secret);
    }
  }

  open(id?: string): OpenedSession {
    const now = Date.now();

    for (const [key, session] of this.browsers) if (now - session.touched > 86_400_000) this.browsers.delete(key);
    const previous = id ? this.browsers.get(id) : undefined;

    if (id && previous) {
      previous.touched = now;

      return { id, session: previous };
    }

    if (this.browsers.size >= 10_000) {
      let oldest: string | undefined;
      let touched = Infinity;

      for (const [key, session] of this.browsers)
        if (!session.identity && session.touched < touched) {
          oldest = key;
          touched = session.touched;
        }

      if (oldest === undefined) throw new ApplicationError(503, 'Too many browser sessions');
      this.browsers.delete(oldest);
    }

    const token = randomBytes(32).toString('base64url');

    const session: BrowserSession = {
      csrf: randomBytes(32).toString('base64url'),
      identity: null,
      selected: false,
      pendingImport: null,
      touched: now,
    };

    this.browsers.set(token, session);

    return { id: token, session };
  }

  validCsrf(session: BrowserSession, token: string) {
    if (!session.csrf) return false;
    const expected = Buffer.from(session.csrf);
    const supplied = Buffer.from(token);

    return supplied.length === expected.length && timingSafeEqual(expected, supplied);
  }

  rider(session: BrowserSession) {
    return session.identity ? this.accounts.identity(session.identity) : null;
  }

  bearer(token: string) {
    const payload = token.split('.', 2)[1];

    if (!payload) return null;

    try {
      const parsed = identityPayload.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));

      const identity = verifyIdentity(parsed.session_cookie, this.secret);

      return identity ? this.accounts.identity(identity) : null;
    } catch {
      return null;
    }
  }

  token(identity: string, template: string) {
    const payload = JSON.parse(Buffer.from(template.split('.', 2)[1] ?? '', 'base64url').toString());

    const values = z.record(z.string(), z.json()).parse(payload);

    const body = Buffer.from(
      JSON.stringify({
        ...values,
        session_cookie: signIdentity(identity, this.secret),
      }),
    ).toString('base64url');

    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

    const signature = signToken(`${header}.${body}`);

    return `${header}.${body}.${signature}`;
  }

  tokens(
    rider: NonNullable<ReturnType<AccountsService['get']>>,
    templates: { access: string; refresh: string; id: string },
  ) {
    const identity = identityOf(rider);

    return {
      access_token: this.token(identity, templates.access),
      expires_in: 1_000_021_600,
      refresh_expires_in: 611_975_560,
      refresh_token: this.token(identity, templates.refresh),
      token_type: 'bearer',
      id_token: templates.id,
      'not-before-policy': 1_408_478_984,
      session_state: '0846ab9a-765d-4c3f-a20c-6cac9e86e5f3',
      scope: '',
    };
  }
}
