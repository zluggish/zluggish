import { t } from '#src/i18n/index';
import { RuntimeContext } from '#src/context';
import { isEmail, normalizeEmail } from '#src/dtos/access.dto';
import { normalizeLoginName } from '#src/dtos/management.dto';
import { ApplicationError } from '#src/errors';
import type { User } from '#src/repositories/accounts.repository';
import type { PublicKey } from '#src/repositories/crypto.repository';
import { Context, Effect, Layer, Schema } from 'effect';

/** Who signed in to Cloudflare Access on a launcher. `off`: Access sign-in is not configured. */
export type LauncherIdentity = 'off' | 'unidentified' | { email: string };

/** How long the ticket from the web app to the launcher stays valid. */
const TICKET_MS = 60_000;

/** How long a launcher stays signed in after an Access sign-in. */
export const ACCESS_DEVICE_SECONDS = 30 * 86_400;

/** Clock difference allowed when checking an Access token's times. */
const LEEWAY_SECONDS = 60;

/** How often unknown key ids may make the server fetch the Access signing keys again. */
const KEY_REFRESH_MS = 60_000;

const STATE = /^[\w-]{43}$/;

const tokenHeader = Schema.Struct({ alg: Schema.String, kid: Schema.String });

const tokenClaims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  exp: Schema.Number,
  nbf: Schema.optional(Schema.Number),
  email: Schema.optional(Schema.String),
});

const base64url = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

function fromBase64url(value: string) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

/** The email a rider's username gives them without any group, or null for names that are not an
email somebody can sign in to Cloudflare with (such as the `@local.invalid` placeholder).
*/
function ownEmail(user: Pick<User, 'username'>) {
  const email = normalizeLoginName(user.username);

  return isEmail(email) && !email.endsWith('.invalid') ? email : null;
}

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const repositories = context.accounts.repositories;
  const store = repositories.accessGroupsRepository;
  const accounts = repositories.accountsRepository;
  const crypto = repositories.cryptoRepository;
  const signIn = context.config.network.web.cloudflareAccess;
  const { publicUrl } = context.config.network.web;
  const apiPort = context.config.network.api.port;
  const configured = () => signIn !== null;

  const log = () => context.world.lifecycle.log;

  // Tickets and device tokens are signed with the storage folder's secret key, under their own prefixes.
  const sign = (claims: string) => crypto.signIdentity(claims, context.sessions.secret);

  const signed = (token: string, pattern: RegExp) =>
    pattern.exec(crypto.verifyIdentity(token, context.sessions.secret) ?? '');

  /** The email a launcher's Access device token names, or null when it is missing, forged or expired. */
  function deviceEmail(token: string | undefined) {
    const match = signIn && token ? signed(token, /^access-device-v1:([\w-]+):(\d+)$/) : null;
    const email = match && Number(match[2]) > Date.now() ? normalizeEmail(fromBase64url(match[1] ?? '')) : '';

    return isEmail(email) ? email : null;
  }

  /** Who a launcher's Access device token says signed in. Neither the token nor the email is logged. */
  function identify(device: string | undefined): LauncherIdentity {
    if (!signIn) {
      return 'off';
    }
    const email = deviceEmail(device);
    const outcome = email ? 'access' : device === undefined ? 'missing' : 'invalid';
    log().info('auth.launcher_identity', 'Launcher identity from the Cloudflare Access sign-in', { outcome });

    return email ? { email } : 'unidentified';
  }

  let keys = new Map<string, PublicKey>();
  let keysFetched = 0;

  async function signingKey(kid: string) {
    if (signIn && !keys.has(kid) && Date.now() - keysFetched > KEY_REFRESH_MS) {
      keysFetched = Date.now();

      try {
        const published = await repositories.cloudflareAccessRepository.keys(signIn.teamDomain);
        keys = new Map(
          published
            .filter((key) => key.kty === 'RSA')
            .map((key) => [key.kid, crypto.rsaPublicKey({ kty: key.kty, n: key.n, e: key.e })]),
        );
      } catch (error) {
        log().warn('auth.access_keys_failed', 'Could not fetch the Cloudflare Access signing keys', {
          error: error instanceof Error ? error : String(error),
        });
      }
    }

    return keys.get(kid) ?? null;
  }

  /** The email in a Cloudflare Access token (`Cf-Access-Jwt-Assertion`) for this application, or null. */
  async function accessEmail(token: string | undefined) {
    const parts = token?.split('.') ?? [];

    if (!signIn || parts.length !== 3) {
      return null;
    }
    const [head = '', body = '', signature = ''] = parts;

    try {
      const header = Schema.decodeUnknownSync(tokenHeader)(JSON.parse(fromBase64url(head)));
      const key = header.alg === 'RS256' ? await signingKey(header.kid) : null;

      if (!key || !crypto.verifyRs256(`${head}.${body}`, Buffer.from(signature, 'base64url'), key)) {
        return null;
      }
      const claims = Schema.decodeUnknownSync(tokenClaims)(JSON.parse(fromBase64url(body)));
      const now = Date.now() / 1000;
      const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
      const email = normalizeEmail(claims.email ?? '');

      const valid =
        claims.iss === `https://${signIn.teamDomain}` &&
        audiences.includes(signIn.audience) &&
        claims.exp > now - LEEWAY_SECONDS &&
        (claims.nbf ?? 0) < now + LEEWAY_SECONDS &&
        isEmail(email);

      return valid ? email : null;
    } catch {
      return null;
    }
  }

  /** Enabled riders an email may pick: those in its groups, and the rider whose username it is. */
  function riders(email: string) {
    const wanted = normalizeEmail(email);
    const grouped = new Set(store.ridersFor(wanted));

    return accounts.list().filter((user) => user.enabled && (grouped.has(user.player_id) || ownEmail(user) === wanted));
  }

  function group(id: number) {
    const found = store.group(id);

    if (!found) {
      throw new ApplicationError({ status: 404, message: t('access_group_not_found') });
    }

    return found;
  }

  function overview() {
    const emails = store.emails();
    const members = store.members();
    const users = accounts.list();
    const grouped = new Set(members.map((member) => member.player_id));

    return {
      configured: configured(),
      groups: store.groups().map((found) => ({
        id: found.id,
        name: found.name,
        emails: emails.filter((row) => row.group_id === found.id).map((row) => row.email),
        riders: members.filter((row) => row.group_id === found.id).map((row) => row.player_id),
      })),
      // Emails that still match no rider, newest first.
      seen: store
        .seen()
        .filter((row) => riders(row.email).length === 0)
        .map((row) => ({ email: row.email, lastSeen: row.last_seen })),
      // Enabled riders outside every group whose username is an email: they see only themselves.
      ownEmail: users
        .filter((user) => user.enabled && !grouped.has(user.player_id) && ownEmail(user))
        .map((user) => ({ playerId: user.player_id, email: ownEmail(user) })),
      // Enabled riders no launcher can pick.
      unreachable: users
        .filter((user) => user.enabled && !grouped.has(user.player_id) && !ownEmail(user))
        .map((user) => user.player_id),
    };
  }

  return {
    configured,
    identify,
    /** A fresh value that ties a sign-in to the launcher session that started it. */
    newState: () => crypto.randomBytes(32).toString('base64url'),
    /** Where a launcher signs in: the Access-protected web app, which sends it back with a ticket. */
    signInUrl: (state: string) => `${publicUrl ?? ''}/launcher/link?state=${encodeURIComponent(state)}`,
    accessEmail,
    /** The launcher address that turns a ticket for `email` into a device token, for the session holding `state`. */
    ticketUrl: (email: string, state: string) => {
      const ticket = sign(`access-ticket-v1:${base64url(email)}:${state}:${Date.now() + TICKET_MS}`);
      const port = apiPort === 443 ? '' : `:${apiPort}`;

      return `https://secure.zwift.com${port}/login/?ticket=${encodeURIComponent(ticket)}`;
    },
    /** The email a ticket names, if it is genuine, fresh and was issued for `state`. */
    redeemTicket: (ticket: string, state: string | undefined) => {
      const match =
        signIn && state && STATE.test(state) ? signed(ticket, /^access-ticket-v1:([\w-]+):([\w-]{43}):(\d+)$/) : null;
      const email =
        match && match[2] === state && Number(match[3]) > Date.now()
          ? normalizeEmail(fromBase64url(match[1] ?? ''))
          : '';

      return isEmail(email) ? email : null;
    },
    deviceToken: (email: string) =>
      sign(`access-device-v1:${base64url(email)}:${Date.now() + ACCESS_DEVICE_SECONDS * 1000}`),
    isState: (value: string) => STATE.test(value),
    riders,
    overview: Effect.fn('AccessGroupsService.overview')(function* () {
      return overview();
    }),
    recordSeen: Effect.fn('AccessGroupsService.recordSeen')(function* (email: string) {
      store.recordSeen(normalizeEmail(email), Date.now());
    }),
    create: Effect.fn('AccessGroupsService.create')(function* (name: string) {
      const id = store.create(name);

      return { id, ...overview() };
    }),
    rename: Effect.fn('AccessGroupsService.rename')(function* (id: number, name: string) {
      group(id);
      store.rename(id, name);

      return overview();
    }),
    remove: Effect.fn('AccessGroupsService.remove')(function* (id: number) {
      group(id);
      store.delete(id);

      return overview();
    }),
    addEmail: Effect.fn('AccessGroupsService.addEmail')(function* (id: number, email: string) {
      group(id);
      store.addEmail(id, email);
      store.forgetSeen(email);

      return overview();
    }),
    removeEmail: Effect.fn('AccessGroupsService.removeEmail')(function* (id: number, email: string) {
      group(id);
      store.removeEmail(id, email);

      return overview();
    }),
    addRider: Effect.fn('AccessGroupsService.addRider')(function* (id: number, player: number) {
      group(id);

      if (!accounts.get(player)) {
        throw new ApplicationError({ status: 404, message: t('user_not_found_error') });
      }
      store.addRider(id, player);

      return overview();
    }),
    removeRider: Effect.fn('AccessGroupsService.removeRider')(function* (id: number, player: number) {
      group(id);
      store.removeRider(id, player);

      return overview();
    }),
  };
});

export class AccessGroupsService extends Context.Service<AccessGroupsService, Effect.Success<typeof make>>()(
  'zluggish/AccessGroupsService',
) {
  static readonly layer = Layer.effect(AccessGroupsService, make);
}
