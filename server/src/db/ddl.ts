// Current database schema; protocol-backed tables retain their wire field names.
export const createSchemaSQL = `
CREATE TABLE IF NOT EXISTS "user" ("player_id" INTEGER PRIMARY KEY, "username" TEXT UNIQUE NOT NULL, "first_name" TEXT NOT NULL, "last_name" TEXT NOT NULL, "pass_hash" TEXT, "auth_version" INTEGER NOT NULL DEFAULT 1, "official_player_id" INTEGER, "is_admin" INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS "account_state" ("id" INTEGER PRIMARY KEY, "setup_complete" BOOLEAN NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS "activity" ("id" INTEGER PRIMARY KEY, "player_id" INTEGER, "course_id" INTEGER, "name" TEXT, "f5" INTEGER, "privateActivity" INTEGER, "start_date" TEXT, "end_date" TEXT, "distanceInMeters" REAL, "avg_heart_rate" REAL, "max_heart_rate" REAL, "avg_watts" REAL, "max_watts" REAL, "avg_cadence" REAL, "max_cadence" REAL, "avg_speed" REAL, "max_speed" REAL, "calories" REAL, "total_elevation" REAL, "strava_upload_id" INTEGER, "strava_activity_id" INTEGER, "f22" TEXT, "f23" INTEGER, "fit" BLOB, "fit_filename" TEXT, "subgroupId" INTEGER, "workoutHash" INTEGER, "progressPercentage" REAL, "sport" INTEGER, "date" TEXT, "act_f32" REAL, "act_f33" TEXT, "act_f34" TEXT, "privacy" INTEGER, "fitness_privacy" INTEGER, "club_name" TEXT, "movingTimeInMs" INTEGER, "work" REAL, "tss" REAL, "normalized_power" REAL, "power_zones" TEXT, "power_units" REAL);
CREATE TABLE IF NOT EXISTS "segment_result" ("id" INTEGER PRIMARY KEY, "player_id" INTEGER, "server_realm" INTEGER, "course_id" INTEGER, "segment_id" INTEGER, "event_subgroup_id" INTEGER, "first_name" TEXT, "last_name" TEXT, "world_time" INTEGER, "finish_time_str" TEXT, "elapsed_ms" INTEGER, "power_source_model" INTEGER, "weight_in_grams" INTEGER, "f14" INTEGER, "avg_power" INTEGER, "is_male" INTEGER, "time" TEXT, "player_type" INTEGER, "avg_hr" INTEGER, "sport" INTEGER, "activity_id" INTEGER, "f22" INTEGER, "f23" TEXT);
CREATE TABLE IF NOT EXISTS "route_result" ("id" INTEGER PRIMARY KEY, "player_id" INTEGER, "server_realm" INTEGER, "map_id" INTEGER, "route_hash" INTEGER, "event_id" INTEGER, "world_time" INTEGER, "elapsed_ms" INTEGER, "power_type" INTEGER, "weight_in_grams" INTEGER, "height_in_centimeters" INTEGER, "ftp" INTEGER, "avg_power" INTEGER, "max_power" INTEGER, "avg_hr" INTEGER, "max_hr" INTEGER, "calories" INTEGER, "gender" INTEGER, "player_type" INTEGER, "sport" INTEGER, "activity_id" INTEGER, "steering" INTEGER, "hr_monitor" TEXT, "power_meter" TEXT, "controllable" TEXT, "cadence_sensor" TEXT);
CREATE TABLE IF NOT EXISTS "goal" ("id" INTEGER PRIMARY KEY, "player_id" INTEGER, "sport" INTEGER, "name" TEXT, "type" INTEGER, "periodicity" INTEGER, "target_distance" REAL, "target_duration" REAL, "actual_distance" REAL, "actual_duration" REAL, "created_on" INTEGER, "period_end_date" INTEGER, "status" INTEGER, "timezone" TEXT);
CREATE TABLE IF NOT EXISTS "goal_metrics" ("id" INTEGER PRIMARY KEY, "player_id" INTEGER, "weekGoalTSS" INTEGER, "weekGoalCalories" INTEGER, "weekGoalKjs" INTEGER, "weekGoalDistanceKilometers" REAL, "weekGoalDistanceMiles" REAL, "weekGoalTimeMinutes" INTEGER, "lastUpdated" TEXT, "currentGoalSetting" TEXT, "currentGoalSource" TEXT);
CREATE TABLE IF NOT EXISTS "playback" ("id" INTEGER PRIMARY KEY, "player_id" INTEGER NOT NULL, "uuid" TEXT NOT NULL, "segment_id" INTEGER NOT NULL, "time" REAL NOT NULL, "world_time" INTEGER NOT NULL, "type" INTEGER);
CREATE TABLE IF NOT EXISTS "zfile" ("id" INTEGER PRIMARY KEY, "folder" TEXT NOT NULL, "filename" TEXT NOT NULL, "timestamp" INTEGER NOT NULL, "player_id" INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS "private_event" ("id" INTEGER PRIMARY KEY, "json" TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS "notification" ("id" INTEGER PRIMARY KEY, "event_id" INTEGER NOT NULL, "player_id" INTEGER NOT NULL, "json" TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS "activity_file" ("id" INTEGER PRIMARY KEY, "activity_id" INTEGER NOT NULL, "full" INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS "activity_image" ("id" INTEGER PRIMARY KEY, "player_id" INTEGER NOT NULL, "activity_id" INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS "activity_media" ("id" INTEGER PRIMARY KEY, "player_id" INTEGER NOT NULL, "activity_id" INTEGER NOT NULL, "content_type" TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS "power_curve" ("id" INTEGER PRIMARY KEY, "player_id" INTEGER NOT NULL, "time" TEXT NOT NULL, "power" INTEGER NOT NULL, "power_wkg" REAL NOT NULL, "timestamp" INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS "version" ("version" INTEGER PRIMARY KEY);
`;

export const completionSchemaSQL = `
CREATE TABLE IF NOT EXISTS activity_completion (
 activity_id INTEGER PRIMARY KEY, player_id INTEGER NOT NULL, payload BLOB NOT NULL,
 streak BLOB, done INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS activity_upload (
 activity_id INTEGER NOT NULL, provider TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
 PRIMARY KEY(activity_id, provider)
);`;
