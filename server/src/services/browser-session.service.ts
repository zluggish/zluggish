import type { Sessions } from '#src/repositories/browser-session.repository';

export class SessionsService {
  constructor(private readonly repository: Sessions) {}
  open(...args: Parameters<Sessions['open']>) {
    return this.repository.open(...args);
  }
  validCsrf(...args: Parameters<Sessions['validCsrf']>) {
    return this.repository.validCsrf(...args);
  }
  rider(...args: Parameters<Sessions['rider']>) {
    return this.repository.rider(...args);
  }
  bearer(...args: Parameters<Sessions['bearer']>) {
    return this.repository.bearer(...args);
  }
  token(...args: Parameters<Sessions['token']>) {
    return this.repository.token(...args);
  }
  tokens(...args: Parameters<Sessions['tokens']>) {
    return this.repository.tokens(...args);
  }
  get browsers() {
    return this.repository.browsers;
  }
  get secret() {
    return this.repository.secret;
  }
}
