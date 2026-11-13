import type { RepositoryContext } from '#src/context';
import { ActivitiesService } from '#src/services/activities.service';
import { ConnectionsService } from '#src/services/connections.service';
import { EventsService } from '#src/services/events.service';
import { FilesService } from '#src/services/files.service';
import { FitnessService } from '#src/services/fitness.service';
import { GoalService } from '#src/services/goals.service';
import { IntegrationsService } from '#src/services/integrations.service';
import { ImportsService } from '#src/services/profile-import.service';
import { ProfilesService } from '#src/services/profile.service';
import { RecordDataService } from '#src/services/record-data.service';
import { RecordsService } from '#src/services/records.service';
import { SettingsService } from '#src/services/settings.service';
import { SocialService } from '#src/services/social.service';
import { StorageService } from '#src/services/storage.service';
import { UploadsService } from '#src/services/uploads.service';
import { WorkoutsService } from '#src/services/workout.service';

export function createServices(context: RepositoryContext) {
  const logging = context.accounts.repositories.loggingRepository;
  logging.configure(context.config.logging);
  context.world.lifecycle.log = logging.child({ component: 'server' });
  context.world.lifecycle.intervalSeconds = context.config.logging.rideProgressIntervalSeconds;

  return {
    accounts: context.accounts,
    sessions: context.sessions,
    profiles: new ProfilesService(context),
    settings: new SettingsService(context),
    connections: new ConnectionsService(context),
    imports: new ImportsService(context.accounts, context.world),
    workouts: new WorkoutsService(context),
    uploads: new UploadsService(context),
    files: new FilesService(context.accounts.repositories),
    recordData: new RecordDataService(context),
    goals: new GoalService(context),
    fitness: new FitnessService(context),
    storage: new StorageService(context),
    records: new RecordsService(context),
    events: new EventsService(context),
    activities: new ActivitiesService(context),
    social: new SocialService(context),
    integrations: new IntegrationsService(context),
  };
}

export type Services = ReturnType<typeof createServices>;
