import { Context, Effect, Layer } from 'effect';
import { RuntimeContext } from '#src/context';
import type { RiderSettings } from '#src/config/index';
import { validateRiderSettings } from '#src/config/index';
import type { SettingsStore } from '#src/repositories/settings.repository';
import type { Overrides } from '#src/dtos/settings.dto';
import { UploadsService } from '#src/services/uploads.service';

function resolveRiderSettings(defaults: RiderSettings, overrides: Overrides) {
  return validateRiderSettings({
    ghosts: { enabled: overrides['ghosts.enabled'] ?? defaults.ghosts.enabled },
    uploads: {
      zwift: {
        enabled: overrides['uploads.zwift.enabled'] ?? defaults.uploads.zwift.enabled,
      },
      strava: {
        method: overrides['uploads.strava.method'] ?? defaults.uploads.strava.method,
      },
      garmin: {
        device: {
          enabled: overrides['uploads.garmin.device.enabled'] ?? defaults.uploads.garmin.device.enabled,
        },
      },
    },
    devices: {
      zwiftClick: {
        enabled: overrides['devices.zwiftClick.enabled'] ?? defaults.devices.zwiftClick.enabled,
      },
    },
    workouts: {
      trainingpeaks: {
        bridgeFolder: overrides['workouts.trainingpeaks.bridgeFolder'] ?? defaults.workouts.trainingpeaks.bridgeFolder,
      },
    },
  });
}

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const repositories = context.accounts.repositories;
  const uploadsService = yield* UploadsService;

  return {
    revision: Effect.fn('SettingsService.revision')(function* (id: number) {
      return repositories.settingsRepository.revision(id);
    }),

    read: Effect.fn('SettingsService.read')(function* (...args: Parameters<SettingsStore['read']>) {
      return repositories.settingsRepository.read(...args);
    }),

    /** A settings change can withdraw consent to a provider: pending deliveries follow. */
    save: Effect.fn('SettingsService.save')(function* (...args: Parameters<SettingsStore['save']>) {
      repositories.settingsRepository.save(...args);
      yield* uploadsService.revoke(args[0]);
    }),

    import: Effect.fn('SettingsService.import')(function* (...args: Parameters<SettingsStore['import']>) {
      return repositories.settingsRepository.import(...args);
    }),

    world: Effect.fn('SettingsService.world')(function* (...args: Parameters<SettingsStore['world']>) {
      return repositories.settingsRepository.world(...args);
    }),

    worldIds: Effect.fn('SettingsService.worldIds')(function* (...args: Parameters<SettingsStore['worldIds']>) {
      return repositories.settingsRepository.worldIds(...args);
    }),

    saveWorld: Effect.fn('SettingsService.saveWorld')(function* (...args: Parameters<SettingsStore['saveWorld']>) {
      return repositories.settingsRepository.saveWorld(...args);
    }),

    resetWorld: Effect.fn('SettingsService.resetWorld')(function* (...args: Parameters<SettingsStore['resetWorld']>) {
      return repositories.settingsRepository.resetWorld(...args);
    }),

    close: Effect.fn('SettingsService.close')(function* (...args: Parameters<SettingsStore['close']>) {
      return repositories.settingsRepository.close(...args);
    }),

    resolveRiderSettings: Effect.fn('resolveRiderSettings')(function* (
      ...args: Parameters<typeof resolveRiderSettings>
    ) {
      return resolveRiderSettings(...args);
    }),
  };
});

export class SettingsService extends Context.Service<SettingsService, Effect.Success<typeof make>>()(
  'zluggish/SettingsService',
) {
  static readonly layer = Layer.effect(SettingsService, make);

  static readonly resolveRiderSettings = resolveRiderSettings;
}
