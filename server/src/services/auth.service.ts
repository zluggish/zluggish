import { t } from '#src/i18n/index';
import { Context } from 'effect';
import { ConfigError } from '#src/config/index';
import { Repositories } from '#src/repositories';
import type { User } from '#src/repositories/accounts.repository';
import { resolve } from 'node:path';

/** A rider's sign-in identity: the identity changes when the password, role or access changes. */
function identityOf(rider: User) {
  return `${rider.player_id}:${rider.auth_version}`;
}

/** The enabled rider with a password whose identity this is, looked up with get; malformed identities
never reach the lookup.
*/
function resolveIdentity(identity: string, get: (id: number) => User | null): User | null {
  if (!/^\d+:\d+$/.test(identity)) {
    return null;
  }
  const [id = 0, version] = identity.split(':').map(Number);
  const rider = get(id);

  return rider && rider.enabled === 1 && rider.pass_hash && rider.auth_version === version ? rider : null;
}

/** Open the account database in a storage folder. The returned store is synchronous: transactions
must not yield, so the account and repository calls stay plain functions.
*/
function open(storage: string) {
  const repositories = new Repositories(storage);
  const { db } = repositories;
  const repository = repositories.accountsRepository;
  let onRevoke: ((id: number) => void) | undefined;

  function list() {
    return repository.list();
  }

  function get(id: number) {
    return repository.get(id);
  }

  function byUsername(username: string) {
    return repository.byUsername(username);
  }

  function loginNameTaken(username: string, except?: number) {
    return repository.sameLoginName(username).some((rider) => rider.player_id !== except);
  }

  const identity = (value: string) => resolveIdentity(value, get);

  /** Direct creation for tests and offline tools. Riders are otherwise created only in the management area. */
  async function create(name: string, password: string, username?: string): Promise<User> {
    const displayName = name.trim();

    if (!displayName || displayName.length > 100) {
      throw new ConfigError(t('auth_name_length_invalid'));
    }

    // Every rider has a password; the launcher can remember it per computer instead.
    if (!password) {
      throw new ConfigError(t('auth_password_required'));
    }
    const passwordHash = await repositories.cryptoRepository.hashPassword(password);
    let created: string | null = null;
    db.exec('BEGIN IMMEDIATE');

    try {
      const occupied = [
        ...list().map((user) => user.player_id),
        ...repositories.filesRepository
          .readdirSync(storage)
          .filter((name) => /^\d+$/.test(name))
          .map(Number),
      ];

      const id = Math.max(0, ...occupied) + 1;

      if (!Number.isSafeInteger(id) || id > 2_147_483_647) {
        throw new ConfigError(t('rider_id_space_exhausted'));
      }
      const folder = resolve(storage, String(id));
      repositories.filesRepository.mkdirSync(folder);
      created = folder;
      const [first = '', ...rest] = displayName.split(/\s+/);
      repository.insert({
        player_id: id,
        username: username ?? `rider-${repositories.cryptoRepository.randomBytes(12).toString('hex')}@local.invalid`,
        first_name: first,
        last_name: rest.join(' '),
        pass_hash: passwordHash,
        auth_version: 1,
        official_player_id: null,
      });

      const user = get(id);

      if (!user) {
        throw new Error(t('created_rider_unavailable'));
      }

      db.exec('COMMIT');

      return user;
    } catch (error) {
      if (db.isTransaction) {
        db.exec('ROLLBACK');
      }

      if (created) {
        repositories.filesRepository.rmSync(created, { recursive: true, force: true });
      }

      throw error;
    }
  }

  async function verify(rider: User, password: string) {
    // Spend the same hashing work as a real check, so timing does not reveal the account state.
    if (!rider.enabled || !rider.pass_hash) {
      await repositories.cryptoRepository.hashPassword(password);

      return false;
    }

    const valid = await repositories.cryptoRepository.verifyPassword(rider.pass_hash, password);
    const current = get(rider.player_id);

    return !!(
      valid &&
      current?.enabled &&
      current.auth_version === rider.auth_version &&
      current.pass_hash === rider.pass_hash &&
      current.username === rider.username
    );
  }

  async function changePassword(id: number, password: string, admin = false, live: () => boolean = () => true) {
    if (!password) {
      throw new ConfigError(t('auth_password_empty'));
    }
    const before = get(id);
    const hash = await repositories.cryptoRepository.hashPassword(password);
    const current = get(id);

    if (
      !live() ||
      !before ||
      !current ||
      current.auth_version !== before.auth_version ||
      current.pass_hash !== before.pass_hash
    ) {
      throw new ConfigError(t('account_changed_retry'));
    }
    repository.setPassword(id, hash, admin);
    onRevoke?.(id);
  }

  function close() {
    if (db.isOpen) {
      db.close();
    }
  }

  return {
    storage,
    db,
    repository,
    repositories,
    get onRevoke() {
      return onRevoke;
    },
    set onRevoke(handler: ((id: number) => void) | undefined) {
      onRevoke = handler;
    },
    list,
    get,
    byUsername,
    loginNameTaken,
    identityOf,
    identity,
    create,
    verify,
    changePassword,
    close,
  };
}

/** The account database and its repositories, shared by every service. */
export class AccountsService extends Context.Service<AccountsService, ReturnType<typeof open>>()(
  'zluggish/AccountsService',
) {
  static readonly open = open;

  static readonly identityOf = identityOf;

  static readonly resolveIdentity = resolveIdentity;
}
