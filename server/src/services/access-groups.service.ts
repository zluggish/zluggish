import { t } from '#src/i18n/index';
import { RuntimeContext } from '#src/context';
import { isEmail, normalizeEmail } from '#src/dtos/access.dto';
import { normalizeLoginName } from '#src/dtos/management.dto';
import { ApplicationError } from '#src/errors';
import type { User } from '#src/repositories/accounts.repository';
import type { PublicKey } from '#src/repositories/crypto.repository';
import { Context, Effect, Layer, Schema } from 'effect';

/** Who a launcher request says is signed in to Cloudflare. `off`: the feature is not configured. */
export type LauncherIdentity = 'off' | 'unidentified' | { email: string };

/** Why a request carried no usable identity. Logged, never shown: every reason gets the same page. */
type Unidentified = 'missing' | 'bad-secret' | 'unresolved';

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
  // A stored secret digest turns the Gateway check on; the web app makes and removes it.
  const gatewayDigest = () => store.gateway().secret_digest;
  const configured = () => gatewayDigest() !== null || signIn !== null;

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

  function identify(headers: {
    gateway: string | undefined;
    email: string | undefined;
    device?: string | undefined;
  }): LauncherIdentity {
    const digest = gatewayDigest();

    if (digest === null && !signIn) {
      return 'off';
    }

    let reason: Unidentified | null = null;
    const email = normalizeEmail(headers.email ?? '');

    // Only the secret's digest is stored. Comparing digests also takes the same time whatever the supplied length.
    if (digest === null || headers.gateway === undefined) {
      reason = 'missing';
    } else if (
      !crypto.timingSafeEqual(Buffer.from(crypto.sha256(headers.gateway), 'hex'), Buffer.from(digest, 'hex'))
    ) {
      reason = 'bad-secret';
    } else if (!isEmail(email)) {
      reason = 'unresolved';
    }

    if (!reason) {
      log().info('auth.launcher_identity', 'Launcher request with a Cloudflare identity', { outcome: 'ok' });

      return { email };
    }
    const device = deviceEmail(headers.device);

    if (device) {
      log().info('auth.launcher_identity', 'Launcher request with a Cloudflare Access sign-in', { outcome: 'access' });

      return { email: device };
    }
    log().info('auth.launcher_identity', 'Launcher request without a Cloudflare identity', { outcome: reason });

    return 'unidentified';
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

  function gatewayStatus() {
    const row = store.gateway();
    const facts = row.certificate ? crypto.certificateFacts(row.certificate) : null;

    return {
      enabled: row.secret_digest !== null,
      secretCreatedAt: row.secret_created_at,
      certificate: facts && { subject: facts.subject, notAfter: facts.notAfter.toISOString() },
    };
  }

  function overview() {
    const emails = store.emails();
    const members = store.members();
    const users = accounts.list();
    const grouped = new Set(members.map((member) => member.player_id));

    return {
      configured: configured(),
      gateway: gatewayStatus(),
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
    gatewayConfigured: () => gatewayDigest() !== null,
    /** Gateway's inspection root as PEM, for Zwift's own certificate list, or ''. */
    gatewayCertificate: () => store.gateway().certificate ?? '',
    signInConfigured: () => signIn !== null,
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
    /** Make a new Gateway secret, which turns the Gateway check on or replaces the earlier secret. It is returned
    this once; only its digest is kept. */
    generateGatewaySecret: Effect.fn('AccessGroupsService.generateGatewaySecret')(function* (by: number) {
      const replaced = gatewayDigest() !== null;
      const secret = crypto.randomBytes(32).toString('hex');
      store.updateGateway({ secret_digest: crypto.sha256(secret), secret_created_at: Date.now() });
      log().info('access.gateway_secret_created', 'An administrator made a new Cloudflare Gateway secret', {
        playerId: by,
        replaced,
      });

      return { secret, ...overview() };
    }),
    /** Remove the secret, which turns the Gateway check off. */
    removeGatewaySecret: Effect.fn('AccessGroupsService.removeGatewaySecret')(function* (by: number) {
      store.updateGateway({ secret_digest: null, secret_created_at: null });
      log().info('access.gateway_secret_removed', 'An administrator removed the Cloudflare Gateway secret', {
        playerId: by,
      });

      return overview();
    }),
    /** Keep Gateway's inspection root certificate (PEM or DER) for client setup, or remove it with null. */
    setGatewayCertificate: Effect.fn('AccessGroupsService.setGatewayCertificate')(function* (bytes: Uint8Array | null) {
      const pem = bytes ? crypto.caCertificatePem(bytes) : null;

      if (bytes && !pem) {
        throw new ApplicationError({ status: 400, message: t('access_certificate_invalid') });
      }
      store.updateGateway({ certificate: pem });

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
