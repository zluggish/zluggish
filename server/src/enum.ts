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
} as const;

export type UploadState = (typeof UploadState)[keyof typeof UploadState];
