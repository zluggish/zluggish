import { RuntimeContext } from '#src/context';
import type { RepositoryContext } from '#src/context';
import { RecordsService } from '#src/services/records.service';
import { SettingsService } from '#src/services/settings.service';
import { GoalService } from '#src/services/goals.service';
import { MetricsService } from '#src/services/metrics.service';
import { RecordDataService } from '#src/services/record-data.service';
import { SocialService } from '#src/services/social.service';
import { FitnessService } from '#src/services/fitness.service';
import { StorageService } from '#src/services/storage.service';
import { DocumentsService } from '#src/services/documents.service';
import { EventsService } from '#src/services/events.service';
import { IntegrationsService } from '#src/services/integrations.service';
import { ConnectionsService } from '#src/services/connections.service';
import { ProfilesService } from '#src/services/profile.service';
import { FilesService } from '#src/services/files.service';
import { StreakService } from '#src/services/streak.service';
import { FitService } from '#src/services/fit.service';
import { AchievementService } from '#src/services/achievement.service';
import { MessageService } from '#src/services/message.service';
import { EventCatalogService } from '#src/services/event-catalog.service';
import { ProfileJsonService } from '#src/services/profile-json.service';
import { WorkoutsService } from '#src/services/workout.service';
import { JobsService } from '#src/services/jobs.service';
import { ImportsService } from '#src/services/profile-import.service';
import { DurabilityService } from '#src/services/durability.service';
import { BackupService } from '#src/services/backup.service';
import { CompanionService } from '#src/services/companion.service';
import { TlsService } from '#src/services/tls.service';
import { RetentionService } from '#src/services/retention.service';
import { UploadsService } from '#src/services/uploads.service';
import { ActivitiesService } from '#src/services/activities.service';
import { RideRecoveryService } from '#src/services/ride-recovery.service';
import { RideCompletionService } from '#src/services/ride-completion.service';
import { WebSessionsService } from '#src/services/web-session.service';
import { ManagementService } from '#src/services/management.service';
import { ChatService } from '#src/services/chat-bridge.service';
import { DiscordService } from '#src/services/discord.service';
import { MatrixService } from '#src/services/matrix.service';
import { AccountsService } from '#src/services/auth.service';
import { SessionsService } from '#src/services/browser-session.service';
import { ZwiftUpdatesService } from '#src/services/zwift-updates.service';
import { Layer, ManagedRuntime } from 'effect';

const foundationLayer = Layer.mergeAll(
  StreakService.layer,
  WebSessionsService.layer,
  WorkoutsService.layer,
  JobsService.layer,
  ImportsService.layer,
  DurabilityService.layer,
  FitService.layer,
  AchievementService.layer,
  MessageService.layer,
  EventCatalogService.layer,
  ProfileJsonService.layer,
  FilesService.layer,
  DocumentsService.layer,
  TlsService.layer,
  ZwiftUpdatesService.layer,
);

const sharedLayer = Layer.mergeAll(UploadsService.layer, ChatService.layer).pipe(Layer.provideMerge(foundationLayer));

/** The account, activity and world services. Each tier may use the ones below it. */
const featuresLayer = Layer.mergeAll(
  ProfilesService.layer,
  DiscordService.layer,
  MatrixService.layer,
  ActivitiesService.layer,
  RideRecoveryService.layer,
  RideCompletionService.layer,
  RetentionService.layer,
  BackupService.layer,
  CompanionService.layer,
  ConnectionsService.layer,
  IntegrationsService.layer,
  EventsService.layer,
  StorageService.layer,
  FitnessService.layer,
  SocialService.layer,
  RecordDataService.layer,
  MetricsService.layer,
  GoalService.layer,
  SettingsService.layer,
  RecordsService.layer,
).pipe(Layer.provideMerge(sharedLayer));

/** Every application service, built from the runtime context. Management uses the services below it. */
export const servicesLayer = ManagementService.layer.pipe(Layer.provideMerge(featuresLayer));

/** Every service an application effect may use. Listed rather than inferred: the runtime context
refers to the runtime, so an inferred type would be circular.
*/
export type AppServices =
  | RuntimeContext
  | AccountsService
  | SessionsService
  | ChatService
  | DiscordService
  | MatrixService
  | WebSessionsService
  | ManagementService
  | UploadsService
  | ActivitiesService
  | RideRecoveryService
  | RideCompletionService
  | JobsService
  | ImportsService
  | DurabilityService
  | RetentionService
  | BackupService
  | CompanionService
  | TlsService
  | StreakService
  | FitService
  | AchievementService
  | MessageService
  | EventCatalogService
  | ProfileJsonService
  | FilesService
  | DocumentsService
  | WorkoutsService
  | ProfilesService
  | ConnectionsService
  | IntegrationsService
  | EventsService
  | StorageService
  | FitnessService
  | SocialService
  | RecordDataService
  | MetricsService
  | GoalService
  | SettingsService
  | ZwiftUpdatesService
  | RecordsService;

export function appLayer(context: RepositoryContext) {
  return servicesLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(RuntimeContext, context),
        Layer.succeed(AccountsService, context.accounts),
        Layer.succeed(SessionsService, context.sessions),
      ),
    ),
  );
}

/** Runs application effects. HTTP handlers, sockets and the world loop use it at their edges. Opening
it configures logging for the context, so the server logs from the start.
*/
export function makeAppRuntime(context: RepositoryContext): AppRuntime {
  const logging = context.accounts.repositories.loggingRepository;
  logging.configure(context.config.logging);
  context.world.lifecycle.log = logging.child({ component: 'server' });
  context.world.lifecycle.intervalSeconds = context.config.logging.rideProgressIntervalSeconds;

  return ManagedRuntime.make(appLayer(context));
}

export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;
