# Zluggish CLI

The CLI manages operator configuration, rider settings, legacy migrations, and local account recovery. It works directly with configuration files and storage; it does not connect to a running server or start one.

Run the commands below from the **repository root**. Replace sample paths and rider ID `1` with your own values. Stop every server using the target storage before running `accounts migrate`, `accounts recover`, `config migrate` (except `--dry-run`), or `settings set/reset` (except `--dry-run`). These operations take an exclusive storage lock.

## Run natively

Use Node **24.15 or later within the 24.x series** and **pnpm 10.28.1**. The admin CLI is part of the server package and operates directly on server storage.

### macOS and Linux

With the required Node version installed, enable the pinned pnpm version and build:

```sh
corepack enable
corepack prepare pnpm@10.28.1 --activate
pnpm --dir server install --frozen-lockfile
pnpm --dir server build
node server/dist/src/cli/bin.js --help
```

The server build includes the CLI. Run a command using the compiled entry point:

```sh
node server/dist/src/cli/bin.js --config ./examples/zluggish.config.ts config validate
```

Alternatively, run the TypeScript entry point without compiling:

```sh
pnpm --dir server cli --help
pnpm --dir server cli --config ./examples/zluggish.config.ts config validate
```

### Windows (PowerShell)

Native Windows execution is supported by the code, including Windows storage locks, but these instructions have not been verified on Windows. Install the same Node and pnpm versions, open PowerShell in the repository root, and run:

```powershell
corepack enable
corepack prepare pnpm@10.28.1 --activate
pnpm --dir server install --frozen-lockfile
pnpm --dir server build
node .\server\dist\src\cli\bin.js --help
node .\server\dist\src\cli\bin.js --config .\server\zluggish.config.ts config validate
```

The TypeScript entry point also works with `pnpm --dir server cli --help`. Quote paths containing spaces, for example `--storage-dir 'C:\Zluggish Data\storage'`. If native dependency installation fails on your Windows architecture, use the Linux-container instructions below with Docker Desktop.

## Run with Docker Compose

The server image includes the `zluggish` admin command and all its dependencies. No Node or pnpm installation is needed on the host. Use the existing [Compose service](../docker/docker-compose.yml), which mounts the same storage and uses the same container configuration as the server:

```sh
docker compose -f docker/docker-compose.yml run --rm --no-deps zluggish zluggish --help
docker compose -f docker/docker-compose.yml run --rm --no-deps zluggish zluggish config validate
```

For offline changes, stop the server first, run the command, then restart after success:

```sh
docker compose -f docker/docker-compose.yml stop zluggish
docker compose -f docker/docker-compose.yml run --rm --no-deps zluggish zluggish accounts migrate
docker compose -f docker/docker-compose.yml up -d zluggish
```

Compose `run` does not publish service ports. All paths supplied to the CLI must be container paths; mount external configuration or password files into the container when needed. The default container config selects the mounted storage at `/usr/src/app/zwift-offline/storage`. The CLI selects an existing config in that storage automatically, matching server startup; before the first startup it uses the image default. For config migration, select an output path on a writable mount.

You can also run the image directly against a storage directory:

```sh
docker run --rm -v /absolute/path/to/storage:/usr/src/app/zwift-offline/storage ghcr.io/zluggish/zluggish:latest zluggish config validate
```

These commands require an image built with the integrated CLI. For a local source checkout, build it with `docker compose -f docker/docker-compose.yml build zluggish` first. Config files are trusted code, and the CLI has full administrative access to mounted storage.

## Configuration and common options

Every example below uses `node server/dist/src/cli/bin.js`. You can replace that prefix with `pnpm --dir server cli` or `docker compose -f docker/docker-compose.yml run --rm --no-deps zluggish zluggish`.

| Option              | Meaning                                                                               |
| ------------------- | ------------------------------------------------------------------------------------- |
| `--help`, `-h`      | Print CLI help. Running without arguments also prints help.                           |
| `--config PATH`     | Select the operator config. The filename must be `zluggish.config.ts`.                |
| `--storage-dir DIR` | Select storage explicitly. Relative paths resolve from the current working directory. |

Config selection is `--config`, then `ZLUGGISH_CONFIG`, then an existing config in container storage, then `server/zluggish.config.ts` in this checkout. For commands that load config, storage selection is `--storage-dir`, then `ZLUGGISH_STORAGE_DIR`, then the config's `storageDir`. Paths in the config resolve relative to the config file.

`config migrate` selects storage from `--storage-dir`, `ZLUGGISH_STORAGE_DIR`, or the repository's `storage/`; it does not load the destination config. Account commands use those explicit storage options first, otherwise an existing selected config's storage, otherwise the repository's `storage/`.

Config files are trusted executable TypeScript. Editing operator config requires a server restart. Legacy JSONC configuration is not loaded. Commands return `0` on success and `2` on failure; Node may also print an experimental SQLite warning.

## Configuration commands

| Command                                             | Behavior                                                                                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config init`                                       | Copy the default typed config to the selected path; refuse to overwrite an existing file.                                                                             |
| `config validate`                                   | Evaluate the config and validate values and referenced resource files.                                                                                                |
| `config show`                                       | Print a JSON summary of config path, storage, network, accounts, and bot enablement/multiplier. Sensitive sections are omitted; this is not a complete config export. |
| `config typecheck`                                  | Typecheck the selected config without emitting files. TypeScript is included in the server image. Reports diagnostic codes and returns `2` for errors.                |
| `config migrate --dry-run`                          | Preview migration of legacy marker/text/INI/JSON settings without writing.                                                                                            |
| `config migrate [--output PATH] [--solo-player ID]` | Migrate legacy settings into a typed config and SQLite overrides while preserving original files. Output defaults to the selected config path.                        |

```sh
node server/dist/src/cli/bin.js config init
node server/dist/src/cli/bin.js config validate
node server/dist/src/cli/bin.js config show
node server/dist/src/cli/bin.js config typecheck
node server/dist/src/cli/bin.js --storage-dir ./storage config migrate --dry-run
node server/dist/src/cli/bin.js --storage-dir ./storage config migrate --output ./storage/zluggish.config.ts --solo-player 42
```

Run `config init` for a fresh setup or `config migrate` for legacy storage. Migration requires a new destination named `zluggish.config.ts`; do not create it with `config init` first. `--solo-player` selects the local legacy profile folder ID when solo ownership needs an explicit choice. It may differ from an imported official Zwift ID. Config migration does not migrate accounts; use `accounts migrate` separately.

Back up the entire storage directory before migration. If interrupted, rerun the same command with the same destination; preserve `.config-migration.json` and do not edit the partially published config. JSONC-only installations must recreate operator settings manually. See the [migration and rollback runbook](../README.md#migration).

## Rider settings commands

These commands require an existing local rider, identified by numeric `--user ID`, and a valid operator config. Overrides are stored in `storage/settings.db`; TypeScript source is never rewritten.

| Command                                        | Behavior                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `settings show --user ID`                      | Print effective rider settings as JSON, merging config defaults with saved overrides.             |
| `settings set --user ID KEY VALUE [--dry-run]` | Validate and save one override. `VALUE` must be JSON. A dry run validates without saving.         |
| `settings reset --user ID KEY [--dry-run]`     | Remove one override so the rider inherits the config default. A dry run validates without saving. |

The available keys are:

| Key                                   | JSON value                             |
| ------------------------------------- | -------------------------------------- |
| `ghosts.enabled`                      | `true` or `false`                      |
| `uploads.zwift.enabled`               | `true` or `false`                      |
| `uploads.strava.method`               | `"paid"` or `"free"`                   |
| `devices.zwiftClick.enabled`          | `true` or `false`                      |
| `workouts.trainingpeaks.bridgeFolder` | A JSON string containing a folder path |

```sh
node server/dist/src/cli/bin.js settings show --user 1
node server/dist/src/cli/bin.js settings set --user 1 ghosts.enabled true --dry-run
node server/dist/src/cli/bin.js settings set --user 1 ghosts.enabled true
node server/dist/src/cli/bin.js settings reset --user 1 ghosts.enabled
```

For JSON string values in macOS/Linux shells, preserve the JSON double quotes with shell single quotes:

```sh
node server/dist/src/cli/bin.js settings set --user 1 uploads.strava.method '"free"'
node server/dist/src/cli/bin.js settings set --user 1 workouts.trainingpeaks.bridgeFolder '"/path/to/workouts"'
```

On PowerShell 7.3+ with standard native argument passing, the same quoting works. Older PowerShell versions may strip the JSON double quotes; use the stop-parsing token for literal arguments, for example:

```powershell
node --% server/dist/src/cli/bin.js settings set --user 1 uploads.strava.method \"free\"
```

## Account commands

Account commands run offline against the selected storage. They can run without an operator config when `--storage-dir` points to the intended storage.

### Migrate legacy accounts

```sh
node server/dist/src/cli/bin.js --storage-dir ./storage accounts migrate
node server/dist/src/cli/bin.js --storage-dir ./storage accounts migrate --solo-player 42
```

Back up storage first. Migration creates a database backup with an `.accounts-<timestamp>.bak` suffix and retains local profile IDs and supported password hashes. Use `--solo-player ID` when solo ownership is ambiguous. See the [migration runbook](../README.md#migration) for cutover and rollback.

### Recover a local account

Put the new password in a private UTF-8 file, then run:

```sh
node server/dist/src/cli/bin.js --storage-dir ./storage accounts recover --user 1 --password-file /private/path/new-password.txt
```

On Windows, use a Windows path for the file:

```powershell
node .\server\dist\src\cli\bin.js --storage-dir .\storage accounts recover --user 1 --password-file 'C:\Private\new-password.txt'
```

The CLI reads the password from the file, removes one trailing newline, and does not prompt interactively. Delete the file after successful recovery. Add `--admin` to grant administrator access during recovery; omit it for password-only recovery.

To remove password protection instead:

```sh
node server/dist/src/cli/bin.js --storage-dir ./storage accounts recover --user 1 --remove-password
```

Choose exactly one of `--password-file PATH` and `--remove-password`. Recovery revokes existing tokens.

## Development tools

Shared ESLint, Oxlint, Prettier, and mise configuration live in this folder. Run `mise run check` from `server/` to build, lint, typecheck, test, and check formatting for the server and its CLI. ESLint uses TypeScript-aware correctness rules, import checks and Unicorn conventions. Its starting configuration came from `immich-app/immich`'s `server/eslint.config.mjs`. The vendored Oxlint rules record their source revision in [UPSTREAM.md](tools/oxlint/anti-slop/UPSTREAM.md).

From `server/`, run `pnpm lint`, `pnpm typecheck`, `pnpm test`, or `pnpm format` for individual checks. `pnpm lint:fix` and `pnpm format:fix` apply automatic fixes. Generated protobuf codecs, bundled assets and vendored lint rules are excluded from application linting and formatting.
