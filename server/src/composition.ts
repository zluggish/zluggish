import type { RepositoryContext } from '#src/context';
import { ActivitiesRepository } from '#src/repositories/activities.repository';
import { Connections } from '#src/repositories/connections.repository';
import { EventsRepository } from '#src/repositories/events.repository';
import { FitnessRepository } from '#src/repositories/fitness.repository';
import { GoalRepository } from '#src/repositories/goal.repository';
import { IntegrationsRepository } from '#src/repositories/integrations.repository';
import { ProfileImports } from '#src/repositories/profile-import.repository';
import { ProtobufRows } from '#src/repositories/protobuf.repository';
import { RecordsRepository } from '#src/repositories/records.repository';
import { SocialRepository } from '#src/repositories/social.repository';
import { StorageRepository } from '#src/repositories/storage.repository';
import { ActivityUploads } from '#src/repositories/uploads.repository';
import { Workouts } from '#src/repositories/workout.repository';
import { AccountsService } from '#src/services/accounts.service';
import { ActivitiesService } from '#src/services/activities.service';
import { SessionsService } from '#src/services/browser-session.service';
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
  return {
    accounts: new AccountsService(context.accounts),
    sessions: new SessionsService(context.sessions),
    profiles: new ProfilesService(context.profiles, context),
    settings: new SettingsService(context.settings),
    connections: new ConnectionsService(new Connections(context.config.storageDir)),
    imports: new ImportsService(new ProfileImports(context.accounts, context.world)),
    workouts: new WorkoutsService(new Workouts(context), context),
    uploads: new UploadsService(new ActivityUploads(context)),
    files: new FilesService(),
    recordData: new RecordDataService(new ProtobufRows(context.accounts.db)),
    goals: new GoalService(new GoalRepository(context.accounts)),
    fitness: new FitnessService(new FitnessRepository(context.accounts.db), context.profiles),
    storage: new StorageService(new StorageRepository(context.accounts.db), context),
    records: new RecordsService(
      new RecordsRepository(context.accounts.db),
      new ProtobufRows(context.accounts.db),
      context,
    ),
    events: new EventsService(new EventsRepository(context.accounts.db), context),
    activities: new ActivitiesService(new ActivitiesRepository(context.accounts.db), context),
    social: new SocialService(new SocialRepository(context.accounts.db), context),
    integrations: new IntegrationsService(new IntegrationsRepository(context.accounts.db)),
  };
}

export type Services = ReturnType<typeof createServices>;
