import type { Rider, Accounts } from '#src/domain/accounts/repository';
import type { BrowserSession, Sessions } from '#src/domain/accounts/sessions';
import type { ResolvedConfig } from '#src/config/index';
import type { World } from '#src/world/state';
import type { SettingsStore } from '#src/node/persistence/settings';
import type { Profiles } from '#src/domain/profiles/store';

export interface Runtime {
  discord?: import('#src/node/integrations/discord').DiscordBridge;
  config: ResolvedConfig;
  accounts: Accounts;
  sessions: Sessions;
  world: World;
  settings: SettingsStore;
  profiles: Profiles;
  assets: string;
  tokens: { access: string; refresh: string; id: string };
  /** Overrides the default SIGINT used by the admin restart countdown. */
  stop?: () => void;
}

export type RuntimeEnv = {
  Variables: {
    rider: Rider | null;
    browser: BrowserSession;
    browserId: string;
  };
};
