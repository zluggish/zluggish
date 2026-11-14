import { ConfigError } from '#src/config/index';
import { Repositories } from '#src/repositories';
import type { Rider } from '#src/repositories/accounts.repository';
import { AccountsRepository } from '#src/repositories/accounts.repository';
import { BaseService } from '#src/services/base.service';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export class AccountsService extends BaseService {
  readonly db: DatabaseSync;

  readonly repository: AccountsRepository;

  constructor(readonly storage: string) {
    super(new Repositories(storage));
    this.db = this.repositories.db;
    this.repository = this.accountsRepository;
  }

  list() {
    return this.repository.list();
  }

  get(id: number) {
    return this.repository.get(id);
  }

  byUsername(username: string) {
    return this.repository.byUsername(username);
  }

  // Setup is one-way: first owner creation commits its marker in the same account transaction.
  setupComplete() {
    return this.repository.setupComplete();
  }

  identityOf(rider: Rider) {
    return `${rider.player_id}:${rider.auth_version}`;
  }

  identity(identity: string): Rider | null {
    if (!/^\d+:\d+$/.test(identity)) return null;
    const [id = 0, version] = identity.split(':').map(Number);
    const rider = this.get(id);

    return rider && rider.auth_version === version ? rider : null;
  }

  async create(name: string, password: string, owner = false, username?: string): Promise<Rider> {
    const displayName = name.trim();

    if (!displayName || displayName.length > 100) throw new ConfigError('Enter a name between 1 and 100 characters');
    const passwordHash = password ? await this.cryptoRepository.hashPassword(password) : null;
    let created: string | null = null;
    this.db.exec('BEGIN IMMEDIATE');

    try {
      if (owner && this.setupComplete()) throw new ConfigError('Setup already completed');

      const occupied = [
        ...this.list().map((user) => user.player_id),
        ...this.filesRepository
          .readdirSync(this.storage)
          .filter((name) => /^\d+$/.test(name))
          .map(Number),
      ];

      // TODO: migrate to uuid before we release the first version
      const id = Math.max(0, ...occupied) + 1;

      if (!Number.isSafeInteger(id) || id > 2_147_483_647) throw new ConfigError('Rider ID space exhausted');
      const folder = resolve(this.storage, String(id));
      this.filesRepository.mkdirSync(folder);
      created = folder;
      const [first = '', ...rest] = displayName.split(/\s+/);
      this.repository.insert({
        player_id: id,
        username: username ?? `rider-${this.cryptoRepository.randomBytes(12).toString('hex')}@local.invalid`,
        first_name: first,
        last_name: rest.join(' '),
        pass_hash: passwordHash,
        auth_version: 1,
        official_player_id: null,
        is_admin: owner ? 1 : 0,
      });

      if (owner) this.repository.finishSetup();

      const user = this.get(id);

      if (!user) throw new Error('Created rider unavailable');

      this.db.exec('COMMIT');

      return user;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');

      if (created) this.filesRepository.rmSync(created, { recursive: true, force: true });

      throw error;
    }
  }

  async verify(rider: Rider, password: string) {
    return this.cryptoRepository.verifyPassword(rider.pass_hash, password);
  }

  async changePassword(id: number, password: string | null, admin = false) {
    const hash = password ? await this.cryptoRepository.hashPassword(password) : null;
    this.repository.setPassword(id, hash, admin);
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }
}
