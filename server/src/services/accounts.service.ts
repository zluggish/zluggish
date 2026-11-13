import type { Accounts } from '#src/repositories/accounts.repository';
import { identityOf } from '#src/repositories/accounts.repository';

export class AccountsService {
  constructor(private readonly repository: Accounts) {}
  list(...args: Parameters<Accounts['list']>) {
    return this.repository.list(...args);
  }
  get(...args: Parameters<Accounts['get']>) {
    return this.repository.get(...args);
  }
  byUsername(...args: Parameters<Accounts['byUsername']>) {
    return this.repository.byUsername(...args);
  }
  identity(...args: Parameters<Accounts['identity']>) {
    return this.repository.identity(...args);
  }
  setupComplete(...args: Parameters<Accounts['setupComplete']>) {
    return this.repository.setupComplete(...args);
  }
  create(...args: Parameters<Accounts['create']>) {
    return this.repository.create(...args);
  }
  verify(...args: Parameters<Accounts['verify']>) {
    return this.repository.verify(...args);
  }
  changePassword(...args: Parameters<Accounts['changePassword']>) {
    return this.repository.changePassword(...args);
  }

  identityOf(...args: Parameters<typeof identityOf>) {
    return identityOf(...args);
  }
}
