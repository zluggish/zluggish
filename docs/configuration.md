# Configuration and management CLI

`zluggish` manages configuration and rider preferences. It does not start or stop the server. CLI source is in `cli/`; the server, UI, and CLI share `zluggish_config/`. Python 3.10+ is required; the container and Windows build use Python 3.12.

Install in a virtual environment with `pip install -r requirements.txt` (includes the CLI), or install only the management tool with `pip install -e .`. Run `zluggish --help`, or `python -m cli --help`. Keep the existing `python standalone.py`, Docker, or Windows executable launch method.

## Existing installation: migrate first

The application no longer reads legacy config flags or the database's ghost preference. Only the migration command understands those formats. A missing server JSONC file is an error, before databases, keys, or listeners are initialized.

1. Stop the old server and back up the complete `storage` directory, including `zwift-offline.db`. Migration cannot detect an old server that does not hold the new runtime lock.
2. Inspect the migration without writing anything:

   ```sh
   zluggish --storage-dir /path/to/storage config migrate --dry-run
   ```

3. Apply it while the server remains stopped:

   ```sh
   zluggish --storage-dir /path/to/storage config migrate --output /path/to/storage/config.jsonc
   zluggish --storage-dir /path/to/storage config validate
   ```

4. Restart using the same storage path. If config is outside storage, set `ZLUGGISH_CONFIG` to its absolute path in the server's environment too. Verify rider settings, uploads, bots, and family mode.

The dry-run report includes candidate settings and output paths for review, without credential values. The command preserves current rider preferences, converts bot documents, and references existing credential/asset files. Environment overrides are not baked into the output. Legacy files and database values remain untouched for rollback; runtime never falls back to them. `enable_bots.txt` with no number means multiplier 1; invalid text also means 1, and positive values are capped at 100. Zero/negative multipliers must be corrected before migration. If both proxy flags exist, `cdn-proxy.txt` takes precedence.

Migration validates all candidates before writing, publishes rider/bot files and schemas first, and publishes server config last. It refuses conflicting outputs. If interrupted, keep the server stopped: inspect the reported written paths and retry the same command. Equivalent outputs are reused; differing files require manual resolution. This is an offline conversion, not a multi-file transaction. No files are silently overwritten.

To roll back, stop the server and restore your backup with the old application version. JSONC-only changes made after migration will not be reflected in the old settings. Keep referenced credentials/assets even after archiving old marker files.

## Fresh installation

Copy `examples/config.jsonc` to `storage/config.jsonc` and copy `zluggish_config/schemas/*.json` into storage for editor assistance. Alternatively run the migration command against empty storage to generate defaults and schemas. Explicit setup creates these files; startup and inspection do not.

Server file selection: CLI `--config`, then `ZLUGGISH_CONFIG`, then `storage/config.jsonc`. Storage selection: CLI `--storage-dir`, then `ZLUGGISH_STORAGE_DIR`, then the existing source/executable-relative storage. CLI flags precede the command. An installed CLI outside the source tree requires an explicit storage path. Selecting an external config does not select storage.

For Docker, use paths inside the container and keep the existing storage mount:

```sh
docker compose run --rm --no-deps zoffline zluggish config migrate --dry-run
docker compose run --rm --no-deps zoffline zluggish config migrate --output /usr/src/app/zwift-offline/storage/config.jsonc
```

Stop the service first. Restart with `docker compose up -d` after migration. Additional external config mounts require `ZLUGGISH_CONFIG` to point to the mounted container path. On Windows activate the virtual environment and use the same commands; the frozen server executable still starts the server, while the CLI is installed separately from source.

## Server settings

JSONC supports JSON values, line/block comments, and trailing commas. Duplicate keys, unknown settings, JSON5 extensions (unquoted keys/single quotes), non-finite numbers, wrong types, and unsupported versions are errors. The generated schema is the complete key/default reference. Runtime validation uses the same schema definitions and never downloads schemas.

```jsonc
{
  "$schema": "./config.schema.json",
  "config_version": 1,
  "server": { "multiplayer": true, "family_mode": true },
  "proxy": { "mode": "auto" }, // auto | enabled | disabled
  "bots": { "enabled": true, "multiplier": 1 },
  "user_defaults": {
    "ghosts": { "enabled": false },
    "uploads": { "zwift": { "enabled": false } }
  }
}
```

Server settings resolve from built-in defaults, then the JSONC file, then existing `ZOFFLINE_*`/`LOGLEVEL` overrides. Missing fields use defaults, never old files. `server.family_mode` requires `server.multiplayer`; family mode always shows the rider picker regardless of auto-launch. Server edits require a restart.

`network.host` defaults to an empty bind address. A null per-service host inherits it; API defaults to `0.0.0.0` when the common address is empty. CDN/TCP/UDP/API ports default to 80/3025/3024/443. Existing `ZOFFLINE_SERVER_HOST`, `ZOFFLINE_{CDN,TCP,UDP,API}_{HOST,PORT}`, `ZOFFLINE_API_USE_CERT` and `LOGLEVEL` still work. Certificate override values must be `true` or `false`.

```sh
zluggish config show --sources
zluggish config get server.family_mode
zluggish config set server.multiplayer true
zluggish config set server.family_mode true --dry-run
zluggish config set server.family_mode true
zluggish config reset server.family_mode
```

`set` accepts a JSON value (including quoted strings); `reset` removes the explicit override and reports the inherited value. Both support `--dry-run`. Config editing requires an existing operator file. CLI commands inspect local files/environment, not a running process. `show --format json` emits machine-readable output; diagnostics go to stderr. Exit codes: 0 success, 2 invalid command/configuration, 1 I/O or concurrent-edit failure.

## Per-rider preferences

Rider overrides live in `storage/<player_id>/settings.jsonc`, keyed by stable ID. Anonymous/single-player settings use `storage/anonymous/settings.jsonc`.

```jsonc
{
  "$schema": "../user-settings.schema.json",
  "settings_version": 1,
  // My rider-specific override.
  "ghosts": { "enabled": true }
}
```

Precedence: built-in rider defaults → server `user_defaults` → this rider's file. Explicit false overrides true. Missing files inherit defaults without writes. `reset` returns to inheritance, even if legacy database/marker values still exist. New accounts inherit defaults until a preference is explicitly saved. Migrated riders get explicit values to preserve their existing choices.

```sh
zluggish settings show --user 1 --sources
zluggish settings set --user 1 ghosts.enabled true
zluggish settings set --user 1 uploads.zwift.enabled false
zluggish settings reset --user 1 ghosts.enabled
zluggish settings show --anonymous
```

User keys are `ghosts.enabled`, `uploads.zwift.enabled`, `uploads.strava.method` (`paid` or `free`), `devices.zwift_click.enabled`, and `workouts.trainingpeaks.bridge_folder`. User files cannot change roles, authentication, server modes, or network settings. Unknown player IDs are rejected. UI and CLI changes use the same validated, comment-preserving writer and become effective at the next settings-dependent action. Invalid files fail the affected action with a scoped error, without substituting defaults or crashing the whole server. Upload credentials are a separate prerequisite.

## Bot documents

Peloton/solo-blob configuration is in `storage/peloton.jsonc` and `storage/solo_blob.jsonc`. Their structures and chat commands are unchanged. They keep their existing reload intervals and retain the last valid simulation if an edit is invalid. There is no extra runtime override file.

```sh
zluggish settings show --peloton
zluggish settings set --solo-blob enabled true
zluggish settings set --solo-blob riders 8
```

Select exactly one settings scope: `--user ID`, `--anonymous`, `--peloton`, or `--solo-blob`. The same document writer handles bot chat changes without rewriting unrelated fields/comments. Simulation defaults live with the shared schemas. Regenerate editor artifacts with `python -c 'from zluggish_config.schema import write_schemas; write_schemas()'` after changing schema definitions.

## Assets, secrets, and safe edits

`ghosts.profile_file` and `bots.riders_file` explicitly select optional JSON assets formerly auto-discovered as `ghost_profile.txt` and `bot.txt`. Relative references resolve against the server config's directory. These catalogues remain data files, not configuration flags.

`mail.credentials_file` references the existing Gmail email/password/recovery-host file. `integrations.discord.credentials_file` references the INI credentials (`token` and `webhook`); Discord channel, messages, announcement flag, and enabled status live in JSONC. `integrations.garmin.domain` defaults to `garmin.com`. Do not put tokens/passwords in JSONC: unknown secret keys are rejected and errors never echo source values.

Profiles, activities, recordings, OAuth files, encryption keys, and databases are unchanged. Per-rider Strava upload method, TrainingPeaks bridge folder, and Zwift Click flags migrate into rider JSONC too. Game `variants.txt` remains profile/game data. The old database ghost column is retained only for schema/rollback compatibility; the application does not read or update it.

Edits validate the full candidate, preserve unrelated comments/formatting and permissions, and replace files atomically. Per-file locks live beside managed data; the running server also holds `storage/.server.lock` so the CLI can refuse migration while it runs. Reads create no locks. Uncooperative external editors can still race a write: detected changes produce a retry error, but there is no universal filesystem compare-and-swap.
