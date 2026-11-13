import type { Generated } from 'kysely';

// SQLite returns integers as numbers by default. Writes also accept bigint so
// protobuf int64 values can reach SQLite without passing through Number.
type Integer = number | bigint;

type NullableInteger = Integer | null;

export interface Database {
  user: {
    player_id: Generated<Integer>;
    username: string;
    first_name: string;
    last_name: string;
    pass_hash: Generated<string | null>;
    auth_version: Generated<Integer>;
    official_player_id: Generated<NullableInteger>;
    enable_ghosts: Generated<Integer>;
    is_admin: Generated<Integer>;
    remember: Generated<Integer>;
  };
  account_state: {
    id: Generated<Integer>;
    setup_complete: Generated<Integer>;
  };
  activity: {
    id: Generated<Integer>;
    player_id: Generated<NullableInteger>;
    course_id: Generated<NullableInteger>;
    name: Generated<string | null>;
    f5: Generated<NullableInteger>;
    privateActivity: Generated<NullableInteger>;
    start_date: Generated<string | null>;
    end_date: Generated<string | null>;
    distanceInMeters: Generated<number | null>;
    avg_heart_rate: Generated<number | null>;
    max_heart_rate: Generated<number | null>;
    avg_watts: Generated<number | null>;
    max_watts: Generated<number | null>;
    avg_cadence: Generated<number | null>;
    max_cadence: Generated<number | null>;
    avg_speed: Generated<number | null>;
    max_speed: Generated<number | null>;
    calories: Generated<number | null>;
    total_elevation: Generated<number | null>;
    strava_upload_id: Generated<NullableInteger>;
    strava_activity_id: Generated<NullableInteger>;
    f22: Generated<string | null>;
    f23: Generated<NullableInteger>;
    fit: Generated<Uint8Array | null>;
    fit_filename: Generated<string | null>;
    subgroupId: Generated<NullableInteger>;
    workoutHash: Generated<NullableInteger>;
    progressPercentage: Generated<number | null>;
    sport: Generated<NullableInteger>;
    date: Generated<string | null>;
    act_f32: Generated<number | null>;
    act_f33: Generated<string | null>;
    act_f34: Generated<string | null>;
    privacy: Generated<NullableInteger>;
    fitness_privacy: Generated<NullableInteger>;
    club_name: Generated<string | null>;
    movingTimeInMs: Generated<NullableInteger>;
    work: Generated<number | null>;
    tss: Generated<number | null>;
    normalized_power: Generated<number | null>;
    power_zones: Generated<string | null>;
    power_units: Generated<number | null>;
  };
  segment_result: {
    id: Generated<Integer>;
    player_id: Generated<NullableInteger>;
    server_realm: Generated<NullableInteger>;
    course_id: Generated<NullableInteger>;
    segment_id: Generated<NullableInteger>;
    event_subgroup_id: Generated<NullableInteger>;
    first_name: Generated<string | null>;
    last_name: Generated<string | null>;
    world_time: Generated<NullableInteger>;
    finish_time_str: Generated<string | null>;
    elapsed_ms: Generated<NullableInteger>;
    power_source_model: Generated<NullableInteger>;
    weight_in_grams: Generated<NullableInteger>;
    f14: Generated<NullableInteger>;
    avg_power: Generated<NullableInteger>;
    is_male: Generated<NullableInteger>;
    time: Generated<string | null>;
    player_type: Generated<NullableInteger>;
    avg_hr: Generated<NullableInteger>;
    sport: Generated<NullableInteger>;
    activity_id: Generated<NullableInteger>;
    f22: Generated<NullableInteger>;
    f23: Generated<string | null>;
  };
  route_result: {
    id: Generated<Integer>;
    player_id: Generated<NullableInteger>;
    server_realm: Generated<NullableInteger>;
    map_id: Generated<NullableInteger>;
    route_hash: Generated<NullableInteger>;
    event_id: Generated<NullableInteger>;
    world_time: Generated<NullableInteger>;
    elapsed_ms: Generated<NullableInteger>;
    power_type: Generated<NullableInteger>;
    weight_in_grams: Generated<NullableInteger>;
    height_in_centimeters: Generated<NullableInteger>;
    ftp: Generated<NullableInteger>;
    avg_power: Generated<NullableInteger>;
    max_power: Generated<NullableInteger>;
    avg_hr: Generated<NullableInteger>;
    max_hr: Generated<NullableInteger>;
    calories: Generated<NullableInteger>;
    gender: Generated<NullableInteger>;
    player_type: Generated<NullableInteger>;
    sport: Generated<NullableInteger>;
    activity_id: Generated<NullableInteger>;
    steering: Generated<NullableInteger>;
    hr_monitor: Generated<string | null>;
    power_meter: Generated<string | null>;
    controllable: Generated<string | null>;
    cadence_sensor: Generated<string | null>;
  };
  goal: {
    id: Generated<Integer>;
    player_id: Generated<NullableInteger>;
    sport: Generated<NullableInteger>;
    name: Generated<string | null>;
    type: Generated<NullableInteger>;
    periodicity: Generated<NullableInteger>;
    target_distance: Generated<number | null>;
    target_duration: Generated<number | null>;
    actual_distance: Generated<number | null>;
    actual_duration: Generated<number | null>;
    created_on: Generated<NullableInteger>;
    period_end_date: Generated<NullableInteger>;
    status: Generated<NullableInteger>;
    timezone: Generated<string | null>;
  };
  goal_metrics: {
    id: Generated<Integer>;
    player_id: Generated<NullableInteger>;
    weekGoalTSS: Generated<NullableInteger>;
    weekGoalCalories: Generated<NullableInteger>;
    weekGoalKjs: Generated<NullableInteger>;
    weekGoalDistanceKilometers: Generated<number | null>;
    weekGoalDistanceMiles: Generated<number | null>;
    weekGoalTimeMinutes: Generated<NullableInteger>;
    lastUpdated: Generated<string | null>;
    currentGoalSetting: Generated<string | null>;
    currentGoalSource: Generated<string | null>;
  };
  playback: {
    id: Generated<Integer>;
    player_id: Integer;
    uuid: string;
    segment_id: Integer;
    time: number;
    world_time: Integer;
    type: Generated<NullableInteger>;
  };
  zfile: {
    id: Generated<Integer>;
    folder: string;
    filename: string;
    timestamp: Integer;
    player_id: Integer;
  };
  private_event: {
    id: Generated<Integer>;
    json: string;
  };
  notification: {
    id: Generated<Integer>;
    event_id: Integer;
    player_id: Integer;
    json: string;
  };
  activity_file: {
    id: Generated<Integer>;
    activity_id: Integer;
    full: Integer;
  };
  activity_image: {
    id: Generated<Integer>;
    player_id: Integer;
    activity_id: Integer;
  };
  activity_media: {
    id: Generated<Integer>;
    player_id: Integer;
    activity_id: Integer;
    content_type: string;
  };
  power_curve: {
    id: Generated<Integer>;
    player_id: Integer;
    time: string;
    power: Integer;
    power_wkg: number;
    timestamp: Integer;
  };
  version: {
    version: Generated<Integer>;
  };
  activity_completion: {
    activity_id: Integer;
    player_id: Integer;
    payload: Uint8Array;
    streak: Generated<Uint8Array | null>;
    done: Generated<Integer>;
  };
  activity_upload: {
    activity_id: Integer;
    provider: string;
    state: Generated<string>;
  };
  rider_settings: { player_id: Integer; value: string };
  config_migration: { id: string };
  world_settings: { id: string; value: string };
}
