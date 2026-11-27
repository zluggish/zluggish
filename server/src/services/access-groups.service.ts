import { t } from '#src/i18n/index';
import { RuntimeContext } from '#src/context';
import { readGatewaySecret } from '#src/config/load';
import { isEmail, normalizeEmail } from '#src/dtos/access.dto';
import { normalizeLoginName } from '#src/dtos/management.dto';
import { ApplicationError } from '#src/errors';
import type { User } from '#src/repositories/accounts.repository';
import { Context, Effect, Layer } from 'effect';

/** Who a launcher request says is signed in to Cloudflare. `off`: the feature is not configured. */
export type LauncherIdentity = 'off' | 'unidentified' | { email: string };

/** Why a request carried no usable identity. Logged, never shown: every reason gets the same page. */
type Unidentified = 'missing' | 'bad-secret' | 'unresolved';

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
  const gateway = context.config.network.api.cloudflareGateway;
  // Compare digests so the comparison takes the same time whatever the supplied length.
  const secret = gateway ? Buffer.from(crypto.sha256(readGatewaySecret(gateway.secretFile)), 'hex') : null;

  const log = () => context.world.lifecycle.log;

  function identify(headers: { gateway: string | undefined; email: string | undefined }): LauncherIdentity {
    if (!secret) {
      return 'off';
    }

    let reason: Unidentified | null = null;
    const email = normalizeEmail(headers.email ?? '');

    if (headers.gateway === undefined) {
      reason = 'missing';
    } else if (!crypto.timingSafeEqual(Buffer.from(crypto.sha256(headers.gateway), 'hex'), secret)) {
      reason = 'bad-secret';
    } else if (!isEmail(email)) {
      reason = 'unresolved';
    }

    if (reason) {
      log().info('auth.launcher_identity', 'Launcher request without a Cloudflare identity', { outcome: reason });

      return 'unidentified';
    }

    log().info('auth.launcher_identity', 'Launcher request with a Cloudflare identity', { outcome: 'ok' });

    return { email };
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
      configured: secret !== null,
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
    configured: () => secret !== null,
    identify,
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
