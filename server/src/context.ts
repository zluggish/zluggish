import type { ResolvedConfig } from '#src/config/index';
import type { Accounts } from '#src/repositories/accounts.repository';
import type { Sessions } from '#src/repositories/browser-session.repository';
import type { Profiles } from '#src/repositories/profile.repository';
import type { SettingsStore } from '#src/repositories/settings.repository';
import type { World } from '#src/world/state';

export interface RepositoryContext {
  discord?: import('#src/repositories/discord.repository').DiscordBridge;
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
