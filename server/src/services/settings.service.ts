import type { RiderSettings } from '#src/config/index';
import { validateRiderSettings } from '#src/config/index';
import type { RepositoryContext } from '#src/context';
import type { SettingsStore } from '#src/repositories/settings.repository';
import type { Overrides } from '#src/dtos/settings.dto';
import { BaseService } from '#src/services/base.service';

export class SettingsService extends BaseService {
  constructor(context: RepositoryContext) {
    super(context.accounts.repositories);
  }

  read(...args: Parameters<SettingsStore['read']>) {
    return this.settingsRepository.read(...args);
  }

  save(...args: Parameters<SettingsStore['save']>) {
    return this.settingsRepository.save(...args);
  }

  import(...args: Parameters<SettingsStore['import']>) {
    return this.settingsRepository.import(...args);
  }

  world(...args: Parameters<SettingsStore['world']>) {
    return this.settingsRepository.world(...args);
  }

  worldIds(...args: Parameters<SettingsStore['worldIds']>) {
    return this.settingsRepository.worldIds(...args);
  }

  saveWorld(...args: Parameters<SettingsStore['saveWorld']>) {
    return this.settingsRepository.saveWorld(...args);
  }

  resetWorld(...args: Parameters<SettingsStore['resetWorld']>) {
    return this.settingsRepository.resetWorld(...args);
  }

  close(...args: Parameters<SettingsStore['close']>) {
    return this.settingsRepository.close(...args);
  }

  resolveRiderSettings(...args: Parameters<typeof SettingsService.resolveRiderSettings>) {
    return SettingsService.resolveRiderSettings(...args);
  }

  static resolveRiderSettings(defaults: RiderSettings, overrides: Overrides) {
    return validateRiderSettings({
      ghosts: { enabled: overrides['ghosts.enabled'] ?? defaults.ghosts.enabled },
      uploads: {
        zwift: {
          enabled: overrides['uploads.zwift.enabled'] ?? defaults.uploads.zwift.enabled,
        },
        strava: {
          method: overrides['uploads.strava.method'] ?? defaults.uploads.strava.method,
        },
      },
      devices: {
        zwiftClick: {
          enabled: overrides['devices.zwiftClick.enabled'] ?? defaults.devices.zwiftClick.enabled,
        },
      },
      workouts: {
        trainingpeaks: {
          bridgeFolder:
            overrides['workouts.trainingpeaks.bridgeFolder'] ?? defaults.workouts.trainingpeaks.bridgeFolder,
        },
      },
    });
  }
}
