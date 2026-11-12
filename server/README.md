# TypeScript server migration

Hono uses the `^4.0.0` range; the lockfile currently resolves **4.13.18**. Its Node adapter is **2.1.8**. Node 24.15+ (24.x) and pnpm 10 are required. The server, integrations, tests and tooling require Node only. The Python implementation has been removed.

This package provides typed operator configuration, shared operations for the management CLI in `../cli/`, direct migration from original legacy configuration, SQLite rider preference overrides, generated codecs for all 20 proto2 schemas, tested packet/credential/password compatibility, and a Hono server covering every inventoried HTTP route plus the TCP/UDP/DNS/CDN listeners, accounts, profile import recovery, activities and uploads, workouts, events, records and the ghost/bot/pacer/peloton/blob simulation. **It has not been verified against a real client and still reports `rideReady: false`.** See [docs/compatibility.md](docs/compatibility.md) for the integration matrix, deliberate differences and remaining release gates.

```sh
pnpm --dir server install --frozen-lockfile
pnpm --dir cli install --frozen-lockfile
pnpm --dir cli build
pnpm --dir cli cli config validate
pnpm --dir server test
pnpm --dir server dev
```

The server takes exclusive ownership of the configured storage directory, creating the first-run setup link when no rider exists. Run it against a cloned storage directory and alternate ports until the release gates pass; follow [the cutover runbook](docs/cutover.md) before switching an existing installation.

## Configuration

Edit `server/zluggish.config.ts` and restart. `defineConfig` and the types are exported from `zluggish/config`. The file can export an object or a synchronous function receiving `{ env, configDir }`. The loader evaluates trusted operator code; it is not a sandbox. Values are runtime-validated even when TypeScript typechecking was skipped. Nested resolved settings are read-only.

Config selection is `--config`, then `ZLUGGISH_CONFIG`, then the server installation's `zluggish.config.ts`. There is no working-directory/parent-directory discovery. Relative config paths resolve against the config directory. Storage overrides are `--storage-dir`, then `ZLUGGISH_STORAGE_DIR`, then `storageDir`. The checked-in configuration uses `../storage` so existing root storage stays where it is. No legacy `ZOFFLINE_*` setting overrides are applied.

External config files can import `zluggish/config` without their own `node_modules`: the runtime loader resolves this public helper to the installed server package. Config init never overwrites a file. `config show` intentionally prints only a safe summary; it does not dump integration values or operator strings.

```sh
pnpm --dir cli cli --config /etc/zluggish/zluggish.config.ts config init
pnpm --dir cli cli --config /etc/zluggish/zluggish.config.ts config validate
pnpm --dir cli cli --config /etc/zluggish/zluggish.config.ts config typecheck
```

Typechecking uses the development TypeScript dependency; production images support runtime validation/loading without that dependency. Config module evaluation may execute side effects in operator code; CLI help/init/migrate do not evaluate it.

## Direct legacy migration

Stop all old servers first. Original releases may not hold a storage lock. Back up the entire installation before migration. This command reads original marker/text/INI/JSON configuration and writes **`zluggish.config.ts` directly**. It does not read or write JSONC or JSON Schema artifacts. JSONC-only installations require manual recreation of operator settings.

```sh
pnpm --dir cli cli --storage-dir /path/to/storage config migrate --dry-run
pnpm --dir cli cli --storage-dir /path/to/storage config migrate --output /path/to/zluggish.config.ts
```

Rider overrides go into a separately versioned `storage/settings.db`; the source `zwift-offline.db` and rider binary files remain untouched. Account conversion is a separate operation. Legacy solo preferences require `--solo-player ID` when a profile exists and no account mapping is available; config migration never creates an account. Catalogues/credentials remain referenced by path rather than embedded in generated source.

Migration refuses destination/preference conflicts and preserves all original files. A durable `.config-migration.json` journal records generated source and preference changes. If interrupted, rerun the same migration command and destination before starting a server. Committed migration IDs make retries idempotent and preserve subsequent preference writes. Existing preference databases are backed up consistently through SQLite before publication. Never delete the journal merely because the output config is missing.

Storage ownership uses native OS locks (`flock` on Unix, `LockFileEx` on Windows). Cross-process lock tests run entirely in Node.

## Rider preferences

Effective preferences are built-in defaults, then configured `riderDefaults`, then persisted rider overrides. Resetting a key exposes the configured default. Commands validate the rider against the existing account database.

```sh
pnpm --dir cli cli settings show --user 42
pnpm --dir cli cli settings set --user 42 ghosts.enabled true --dry-run
pnpm --dir cli cli settings set --user 42 ghosts.enabled true
pnpm --dir cli cli settings reset --user 42 ghosts.enabled
```

These commands never edit the TS source. Dry-run/inspection creates no settings database or lock files. Live blob and peloton overrides are stored in SQLite by chat commands, without editing the operator config.

## Integrations

Strava (API or session cookie), Intervals.icu, Runalyze, Garmin and official Zwift uploads run in TypeScript after an activity is saved. Garmin reuses the existing `garth/oauth1_token.json` and `oauth2_token.json` files. Authorization supports a browser-bound verification-code step when Garmin requests MFA. No Python helper is invoked. Live Garmin authorization/upload still requires manual verification.

## Protocol and rule maintenance

Canonical `.proto` files live in `server/proto`. Regenerate TypeScript with `pnpm --dir server codegen`. Generated files are committed and excluded from lint/format checks.

`tests/fixtures/python.json` is frozen synthetic compatibility data captured before Python removal; it contains no Python source, real rider data or credentials. Historical sources are available at Git revision `6940d4f` if new cross-language vectors are needed. Runtime tests do not launch Python.

## Docker development image

```sh
docker build --target server -t zluggish-typescript server
docker run --rm -p 127.0.0.1:8787:8787 \
  -v /path/to/zluggish.config.ts:/etc/zluggish/zluggish.config.ts:ro \
  -v /path/to/storage:/usr/src/app/zwift-offline/storage \
  zluggish-typescript node dist/src/main.js --config /etc/zluggish/zluggish.config.ts
```

For Docker, set `network.host` to `0.0.0.0` and use an absolute container `storageDir` in the mounted config. Bind the host port to loopback. The build context is `server/`, including bundled game data/TLS assets.

## Deployment

Build with `docker build --target server -t zluggish:local server`. The image contains no Python; Garmin runs in the same Node process. Compose builds the Node server and retains root storage mounts. Bundled resources live in `server/assets/`; the Docker context is entirely `server/`. Discord uses the configured INI credential file and is started only when enabled.
