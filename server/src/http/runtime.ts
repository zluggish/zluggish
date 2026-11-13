import type { Services } from '#src/composition';
import type { RepositoryContext } from '#src/context';
import type { Rider } from '#src/repositories/accounts.repository';
import type { BrowserSession } from '#src/repositories/browser-session.repository';

export interface Runtime extends RepositoryContext {
  services: Services;
}

export type HttpRuntime = Omit<Runtime, 'accounts' | 'sessions' | 'profiles' | 'settings'>;

export type RuntimeEnv = {
  Variables: {
    rider: Rider | null;
    browser: BrowserSession;
    browserId: string;
  };
};
