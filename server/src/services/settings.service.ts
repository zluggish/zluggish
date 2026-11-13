import type { SettingsStore } from '#src/repositories/settings.repository';
import { resolveRiderSettings } from '#src/repositories/settings.repository';

export class SettingsService {
  constructor(private readonly repository: SettingsStore) {}
  read(...args: Parameters<SettingsStore['read']>) {
    return this.repository.read(...args);
  }
  save(...args: Parameters<SettingsStore['save']>) {
    return this.repository.save(...args);
  }
  import(...args: Parameters<SettingsStore['import']>) {
    return this.repository.import(...args);
  }
  world(...args: Parameters<SettingsStore['world']>) {
    return this.repository.world(...args);
  }
  worldIds(...args: Parameters<SettingsStore['worldIds']>) {
    return this.repository.worldIds(...args);
  }
  saveWorld(...args: Parameters<SettingsStore['saveWorld']>) {
    return this.repository.saveWorld(...args);
  }
  resetWorld(...args: Parameters<SettingsStore['resetWorld']>) {
    return this.repository.resetWorld(...args);
  }
  close(...args: Parameters<SettingsStore['close']>) {
    return this.repository.close(...args);
  }

  resolveRiderSettings(...args: Parameters<typeof resolveRiderSettings>) {
    return resolveRiderSettings(...args);
  }
}
