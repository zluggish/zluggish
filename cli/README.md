# Zluggish CLI

The CLI manages operator configuration, rider settings, legacy migrations, and local account recovery. It works directly with configuration files and storage; it does not connect to a running server or start one.

Run the commands below from the **repository root**. Replace sample paths and rider ID `1` with your own values. Stop every server using the target storage before running `accounts migrate`, `accounts recover`, `config migrate` (except `--dry-run`), or `settings set/reset` (except `--dry-run`). These operations take an exclusive storage lock.

## Run natively

Use Node **24.15 or later within the 24.x series** and **pnpm 10.28.1**. Both the server and CLI packages must be installed because the CLI imports server configuration and persistence code.

### macOS and Linux

With the required Node version installed, enable the pinned pnpm version and build:

```sh
corepack enable
corepack prepare pnpm@10.28.1 --activate
pnpm --dir server install --frozen-lockfile
pnpm --dir cli install --frozen-lockfile
pnpm --dir cli build
node cli/dist/src/bin.js --help
```

The CLI build also builds the server. Run a command using the compiled entry point:

```sh
node cli/dist/src/bin.js --config ./examples/zluggish.config.ts config validate
```

Alternatively, run the TypeScript entry point without compiling:

```sh
pnpm --dir cli cli --help
pnpm --dir cli cli --config ./examples/zluggish.config.ts config validate
```

### Windows (PowerShell)

Native Windows execution is supported by the code, including Windows storage locks, but these instructions have not been verified on Windows. Install the same Node and pnpm versions, open PowerShell in the repository root, and run:

```powershell
corepack enable
corepack prepare pnpm@10.28.1 --activate
pnpm --dir server install --frozen-lockfile
pnpm --dir cli install --frozen-lockfile
pnpm --dir cli build
node .\cli\dist\src\bin.js --help
node .\cli\dist\src\bin.js --config .\server\zluggish.config.ts config validate
```

The TypeScript entry point also works with `pnpm --dir cli cli --help`. Quote paths containing spaces, for example `--storage-dir 'C:\Zluggish Data\storage'`. If native dependency installation fails on your Windows architecture, use the Linux-container instructions below with Docker Desktop.

## Run with Docker Compose

The existing [server Compose service](../docker/docker-compose.yml) and server image do **not** include the CLI. Create `docker/cli.compose.yml` with this separate service:

```yaml
services:
  cli:
    image: node:24-bookworm-slim
    working_dir: /workspace
    volumes:
      - ..:/workspace
      - cli-server-deps:/workspace/server/node_modules
      - cli-deps:/workspace/cli/node_modules
      - cli-server-dist:/workspace/server/dist
      - cli-dist:/workspace/cli/dist
    entrypoint: ['node', 'cli/dist/src/bin.js']
    command: ['--help']

volumes:
  cli-server-deps:
  cli-deps:
  cli-server-dist:
  cli-dist:
```

Use Docker Engine with Compose on Linux, or Docker Desktop with Linux containers on macOS/Windows. Share the repository directory with Docker if prompted. The bind mount exposes repository files and `storage/` to the container; named volumes keep Linux dependencies and build output separate from native installations.

Install and build once, and repeat after updating source or dependencies. This single-line command works in macOS/Linux shells and PowerShell:

```sh
docker compose -f docker/cli.compose.yml run --rm --entrypoint sh cli -c "corepack enable && corepack prepare pnpm@10.28.1 --activate && pnpm --dir server install --frozen-lockfile && pnpm --dir cli install --frozen-lockfile && pnpm --dir cli build"
```

Then launch the CLI, appending any arguments from the command reference:

```sh
docker compose -f docker/cli.compose.yml run --rm cli --help
docker compose -f docker/cli.compose.yml run --rm cli --config /workspace/examples/zluggish.config.ts config validate
docker compose -f docker/cli.compose.yml run --rm cli --storage-dir /workspace/storage accounts migrate
```

All CLI paths must be **container paths**. For example, host `./storage` is `/workspace/storage`. Files outside the repository, such as password files or external storage, need additional bind mounts in the service. Configured paths must also resolve inside the container. Files written through bind mounts on Linux may be owned by root.

For offline changes, stop the existing server first and restart it after the command succeeds:

```sh
docker compose -f docker/docker-compose.yml stop zluggish
# Run the required CLI command using docker/cli.compose.yml.
docker compose -f docker/docker-compose.yml up -d zluggish
```

This CLI service publishes no ports and does not use the server service's `/etc/localtime` mount.

## Configuration and common options

Every example below uses `node cli/dist/src/bin.js`. You can replace that prefix with `pnpm --dir cli cli` or `docker compose -f docker/cli.compose.yml run --rm cli`.

| Option              | Meaning                                                                               |
| ------------------- | ------------------------------------------------------------------------------------- |
| `--help`, `-h`      | Print CLI help. Running without arguments also prints help.                           |
| `--config PATH`     | Select the operator config. The filename must be `zluggish.config.ts`.                |
| `--storage-dir DIR` | Select storage explicitly. Relative paths resolve from the current working directory. |

Config selection is `--config`, then `ZLUGGISH_CONFIG`, then `server/zluggish.config.ts` in this checkout. For commands that load config, storage selection is `--storage-dir`, then `ZLUGGISH_STORAGE_DIR`, then the config's `storageDir`. Paths in the config resolve relative to the config file.

`config migrate` selects storage from `--storage-dir`, `ZLUGGISH_STORAGE_DIR`, or the repository's `storage/`; it does not load the destination config. Account commands use those explicit storage options first, otherwise an existing selected config's storage, otherwise the repository's `storage/`.

Config files are trusted executable TypeScript. Editing operator config requires a server restart. Legacy JSONC configuration is not loaded. Commands return `0` on success and `2` on failure; Node may also print an experimental SQLite warning.

## Configuration commands

| Command                                             | Behavior                                                                                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config init`                                       | Copy the default typed config to the selected path; refuse to overwrite an existing file.                                                                             |
| `config validate`                                   | Evaluate the config and validate values and referenced resource files.                                                                                                |
| `config show`                                       | Print a JSON summary of config path, storage, network, accounts, and bot enablement/multiplier. Sensitive sections are omitted; this is not a complete config export. |
| `config typecheck`                                  | Typecheck the selected config without emitting files. Requires development dependencies, including TypeScript. Reports diagnostic codes and returns `2` for errors.   |
| `config migrate --dry-run`                          | Preview migration of legacy marker/text/INI/JSON settings without writing.                                                                                            |
| `config migrate [--output PATH] [--solo-player ID]` | Migrate legacy settings into a typed config and SQLite overrides while preserving original files. Output defaults to the selected config path.                        |

```sh
node cli/dist/src/bin.js config init
node cli/dist/src/bin.js config validate
node cli/dist/src/bin.js config show
node cli/dist/src/bin.js config typecheck
node cli/dist/src/bin.js --storage-dir ./storage config migrate --dry-run
node cli/dist/src/bin.js --storage-dir ./storage config migrate --output ./storage/zluggish.config.ts --solo-player 42
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
node cli/dist/src/bin.js settings show --user 1
node cli/dist/src/bin.js settings set --user 1 ghosts.enabled true --dry-run
node cli/dist/src/bin.js settings set --user 1 ghosts.enabled true
node cli/dist/src/bin.js settings reset --user 1 ghosts.enabled
```

For JSON string values in macOS/Linux shells, preserve the JSON double quotes with shell single quotes:

```sh
node cli/dist/src/bin.js settings set --user 1 uploads.strava.method '"free"'
node cli/dist/src/bin.js settings set --user 1 workouts.trainingpeaks.bridgeFolder '"/path/to/workouts"'
```

On PowerShell 7.3+ with standard native argument passing, the same quoting works. Older PowerShell versions may strip the JSON double quotes; use the stop-parsing token for literal arguments, for example:

```powershell
node --% cli/dist/src/bin.js settings set --user 1 uploads.strava.method \"free\"
```

## Account commands

Account commands run offline against the selected storage. They can run without an operator config when `--storage-dir` points to the intended storage.

### Migrate legacy accounts

```sh
node cli/dist/src/bin.js --storage-dir ./storage accounts migrate
node cli/dist/src/bin.js --storage-dir ./storage accounts migrate --solo-player 42
```

Back up storage first. Migration creates a database backup with an `.accounts-<timestamp>.bak` suffix and retains local profile IDs and supported password hashes. Use `--solo-player ID` when solo ownership is ambiguous. See the [migration runbook](../README.md#migration) for cutover and rollback.

### Recover a local account

Put the new password in a private UTF-8 file, then run:

```sh
node cli/dist/src/bin.js --storage-dir ./storage accounts recover --user 1 --password-file /private/path/new-password.txt
```

On Windows, use a Windows path for the file:

```powershell
node .\cli\dist\src\bin.js --storage-dir .\storage accounts recover --user 1 --password-file 'C:\Private\new-password.txt'
```

The CLI reads the password from the file, removes one trailing newline, and does not prompt interactively. Delete the file after successful recovery. Add `--admin` to grant administrator access during recovery; omit it for password-only recovery.

To remove password protection instead:

```sh
node cli/dist/src/bin.js --storage-dir ./storage accounts recover --user 1 --remove-password
```

Choose exactly one of `--password-file PATH` and `--remove-password`. Recovery revokes existing tokens.

## Development tools

Shared ESLint, Oxlint, Prettier, and mise configuration live in this folder. Run `mise run check` from `cli/` to build, lint, typecheck, test, and check formatting for both packages. ESLint uses TypeScript-aware correctness rules, import checks and Unicorn conventions. Its starting configuration came from `immich-app/immich`'s `server/eslint.config.mjs`. The vendored Oxlint rules record their source revision in [UPSTREAM.md](tools/oxlint/anti-slop/UPSTREAM.md).

From `cli/`, run `pnpm lint`, `pnpm typecheck`, `pnpm test`, or `pnpm format` for individual checks. `pnpm lint:fix` and `pnpm format:fix` apply automatic fixes. Generated protobuf codecs, bundled assets and vendored lint rules are excluded from application linting and formatting.
