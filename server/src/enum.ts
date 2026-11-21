export const ActivityPrivacy = {
  Public: 'PUBLIC',
  Private: 'PRIVATE',
  Friends: 'FRIENDS',
} as const;

export type ActivityPrivacy = (typeof ActivityPrivacy)[keyof typeof ActivityPrivacy];

export const ActivitySport = {
  Cycling: 'CYCLING',
  Running: 'RUNNING',
} as const;

export type ActivitySport = (typeof ActivitySport)[keyof typeof ActivitySport];

export const BlobMode = {
  Attack: 'attack',
  Hammer: 'hammer',
  Toast: 'toast',
  Lead: 'lead',
} as const;

export type BlobMode = (typeof BlobMode)[keyof typeof BlobMode];

export const ConnectionProvider = {
  Zwift: 'zwift',
  Intervals: 'intervals',
  Garmin: 'garmin',
  Strava: 'strava',
} as const;

export type ConnectionProvider = (typeof ConnectionProvider)[keyof typeof ConnectionProvider];

export const DownloadFile = {
  ProfileBin: 'profile.bin',
  AchievementsBin: 'achievements.bin',
  UserStorageBin: 'user_storage.bin',
  StreaksBin: 'streaks.bin',
  EconomyConfigTxt: 'economy_config.txt',
} as const;

export type DownloadFile = (typeof DownloadFile)[keyof typeof DownloadFile];

export const FeatureMode = {
  Auto: 'auto',
  Enabled: 'enabled',
  Disabled: 'disabled',
} as const;

export type FeatureMode = (typeof FeatureMode)[keyof typeof FeatureMode];

export const FitnessGoalSetting = {
  TSS: 'TSS',
  KJ: 'KJ',
  Calories: 'CALORIES',
  Distance: 'DISTANCE',
  Time: 'TIME',
} as const;

export type FitnessGoalSetting = (typeof FitnessGoalSetting)[keyof typeof FitnessGoalSetting];

export const GesturePhase = {
  Approach: 'approach',
  Pull: 'pull',
} as const;

export type GesturePhase = (typeof GesturePhase)[keyof typeof GesturePhase];

export const HttpMethod = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Delete: 'DELETE',
} as const;

export type HttpMethod = (typeof HttpMethod)[keyof typeof HttpMethod];

export const ImportFile = {
  ProfileBin: 'profile.bin',
  AchievementsBin: 'achievements.bin',
  EconomyConfigTxt: 'economy_config.txt',
  UserStorageBin: 'user_storage.bin',
  StreaksBin: 'streaks.bin',
} as const;

export type ImportFile = (typeof ImportFile)[keyof typeof ImportFile];

export const ImportState = {
  Staged: 'staged',
  Publishing: 'publishing',
  Committed: 'committed',
} as const;

export type ImportState = (typeof ImportState)[keyof typeof ImportState];

export const LogFormat = {
  Pretty: 'pretty',
  Json: 'json',
} as const;

export type LogFormat = (typeof LogFormat)[keyof typeof LogFormat];

export const LogLevel = {
  Verbose: 'VERBOSE',
  Info: 'INFO',
  Warn: 'WARN',
  Error: 'ERROR',
  Critical: 'CRITICAL',
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

export const LogLevelInput = {
  Verbose: 'VERBOSE',
  Debug: 'DEBUG',
  Info: 'INFO',
  Warning: 'WARNING',
  Warn: 'WARN',
  Error: 'ERROR',
  Critical: 'CRITICAL',
  NotSet: 'NOTSET',
} as const;

export type LogLevelInput = (typeof LogLevelInput)[keyof typeof LogLevelInput];

export const MeetupInviteStatus = {
  Pending: 'PENDING',
  Accepted: 'ACCEPTED',
  Rejected: 'REJECTED',
} as const;

export type MeetupInviteStatus = (typeof MeetupInviteStatus)[keyof typeof MeetupInviteStatus];

export const ProtobufTable = {
  Activity: 'activity',
  Goal: 'goal',
  SegmentResult: 'segment_result',
  RouteResult: 'route_result',
} as const;

export type ProtobufTable = (typeof ProtobufTable)[keyof typeof ProtobufTable];

export const RemovableCredentialFile = {
  ZwiftCredentialsBin: 'zwift_credentials.bin',
  IntervalsCredentialsBin: 'intervals_credentials.bin',
  StravaApiBin: 'strava_api.bin',
  StravaTokenTxt: 'strava_token.txt',
  Strava4SessionTxt: 'strava4_session.txt',
  GarminCredentialsBin: 'garmin_credentials.bin',
  GarthOauth1TokenJson: 'garth/oauth1_token.json',
} as const;

export type RemovableCredentialFile = (typeof RemovableCredentialFile)[keyof typeof RemovableCredentialFile];

export const ResponseMode = {
  Json: 'json',
  Text: 'text',
} as const;

export type ResponseMode = (typeof ResponseMode)[keyof typeof ResponseMode];

export const RiderPosition = {
  Front: 'front',
  Middle: 'middle',
  Back: 'back',
  Any: 'any',
} as const;

export type RiderPosition = (typeof RiderPosition)[keyof typeof RiderPosition];

export const StravaMethod = {
  Paid: 'paid',
  Free: 'free',
} as const;

export type StravaMethod = (typeof StravaMethod)[keyof typeof StravaMethod];

export const UploadProvider = {
  Strava: 'strava',
  FreeStrava: 'freeStrava',
  Garmin: 'garmin',
  Runalyze: 'runalyze',
  Intervals: 'intervals',
  Zwift: 'zwift',
} as const;

export type UploadProvider = (typeof UploadProvider)[keyof typeof UploadProvider];

export const UploadState = {
  Pending: 'pending',
  Sending: 'sending',
  Cancelled: 'cancelled',
  Sent: 'sent',
  Failed: 'failed',
  Ambiguous: 'ambiguous',
} as const;

export type UploadState = (typeof UploadState)[keyof typeof UploadState];

/** Rider state stored in rider_document rows. Names match the legacy rider files. */
export const RiderDocumentName = {
  ProfileBin: 'profile.bin',
  AchievementsBin: 'achievements.bin',
  UserStorageBin: 'user_storage.bin',
  StreaksBin: 'streaks.bin',
  RouteCompletionAchievementsBin: 'route_completion_achievements.bin',
  EconomyConfigTxt: 'economy_config.txt',
  PrivacyJson: 'privacy.json',
  ZwiftCredentialsBin: 'zwift_credentials.bin',
  IntervalsCredentialsBin: 'intervals_credentials.bin',
  GarminCredentialsBin: 'garmin_credentials.bin',
  GarminDeviceTxt: 'garmin_device.txt',
  StravaApiBin: 'strava_api.bin',
  StravaTokenTxt: 'strava_token.txt',
  Strava4SessionTxt: 'strava4_session.txt',
  RunalyzeTokenTxt: 'runalyze_token.txt',
  GarthOauth1TokenJson: 'garth/oauth1_token.json',
  GarthOauth2TokenJson: 'garth/oauth2_token.json',
  EncryptionKeyBin: 'encryption_key.bin',
  RelayAuthVersion: 'relay-auth-version',
} as const;

export type RiderDocumentName = (typeof RiderDocumentName)[keyof typeof RiderDocumentName];

/** Plain-text secrets in legacy files. The database stores them encrypted. */
export const SecretDocuments: ReadonlyArray<RiderDocumentName> = [
  'strava_token.txt',
  'strava4_session.txt',
  'runalyze_token.txt',
  'garth/oauth1_token.json',
  'garth/oauth2_token.json',
  'encryption_key.bin',
];

export const JobType = {
  PowerCurve: 'power_curve',
  FitExport: 'fit_export',
  Chart: 'chart',
  Delivery: 'delivery',
  ArtifactCleanup: 'artifact_cleanup',
  Retention: 'retention',
  StorageBackup: 'storage_backup',
  CompletionDeliveries: 'completion_deliveries',
} as const;

export type JobType = (typeof JobType)[keyof typeof JobType];

export const JobState = {
  Queued: 'queued',
  Running: 'running',
  Done: 'done',
  Failed: 'failed',
} as const;

export type JobState = (typeof JobState)[keyof typeof JobState];
