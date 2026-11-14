import type { ResolvedConfig } from '#src/config/index';
import type { AccountsService } from '#src/services/auth.service';
import type { SessionsService } from '#src/services/browser-session.service';
import type { Profiles } from '#src/repositories/profile.repository';
import type { SettingsStore } from '#src/repositories/settings.repository';
import type { World } from '#src/world/state';

export interface RepositoryContext {
  discord?: import('#src/services/discord.service').DiscordBridge;
  config: ResolvedConfig;
  accounts: AccountsService;
  sessions: SessionsService;
  world: World;
  settings: SettingsStore;
  profiles: Profiles;
  assets: string;
  tokens: { access: string; refresh: string; id: string };
  /** Overrides the default SIGINT used by the admin restart countdown. */
  stop?: () => void;
}
