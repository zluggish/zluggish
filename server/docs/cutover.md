# Cutover and rollback

## Before switching

1. Finish active rides and stop the Python server. Confirm its process/container has exited. Never run two writers against the same storage, including migration commands.
2. Back up the complete storage directory while stopped, plus external config, credential/catalogue files and certificate keys. Keep the old image/source revision. Copy the backup to a separate directory and use that copy for the first Node run.
3. Recreate JSONC-only operator settings in `zluggish.config.ts`. For original marker/INI/JSON installations, run `config migrate --dry-run`, inspect the result, then `config migrate --output /path/to/zluggish.config.ts`. This writes TS directly, plus SQLite preferences. Do not delete interrupted migration journals.
4. Run `accounts migrate` explicitly for old account databases. Use `--solo-player ID` when legacy solo ownership needs an explicit choice. Schema-4 accounts can be opened directly. Account and config migration are separate operations.
5. Validate the selected config with `config validate`. Check the storage path, advertised LAN IP, listener addresses, TLS paths and asset/credential references. For Docker, mount an external config at `/etc/zluggish/zluggish.config.ts` and set `ZLUGGISH_CONFIG` to that path, or use the bundled container config with `ZLUGGISH_ADVERTISED_IP`.

## Test the restored copy

Run Node on an isolated host/network or alternate ports so production clients do not connect accidentally. Select each rider and verify names, progress, achievements, activities, workouts and preferences. Complete a supported desktop ride with bots/pacers/blob features used by the installation; save and inspect the FIT file. Restart, select again, verify saved progress and continue riding. Exercise Companion/Android if used. Keep integration credentials disabled until the local save/restart check succeeds, then verify opted-in services without automatic retries.

Record turns, hills, teleports, reconnects, long rides and behavior under the installation's expected bot load. For cross-language comparisons, use a prior release image or a separate checkout of Git revision `6940d4f`, with separate restored storage copies. Automated protocol and mocked-service tests are not substitutes for these checks.

## Switch

Stop the test process, confirm production is stopped and retain a fresh complete snapshot. Use the tested config and storage for `docker compose up --build -d` or `pnpm --dir server start`. Existing client redirects and certificates do not change. Require rider reselection. Read the first-run setup link only for genuinely fresh storage; an unexpected setup screen on an existing installation means the storage path/account conversion must be checked before riding.

The Node image excludes Python. Garmin uses the TypeScript client and existing token files. Discord is disabled unless explicitly enabled; its bot needs guild-member and message-content intents enabled in Discord's developer settings. Its INI credential file retains `[discord]` token/webhook entries.

## Roll back

Stop Node completely. Preserve its storage as a separate snapshot for investigation. Restore the pre-cutover snapshot to a new directory, then point a previously saved release image/config at that directory and start it. Do not assume the old server can safely consume all later Node writes. Restoring the old snapshot loses post-snapshot progress; retain the Node FIT files separately for manual recovery. Rehearse this sequence on a restored copy before a production switch.

## Platform verification

CI runs TypeScript tests/build/codegen on Linux, Windows and macOS. Native storage locking must pass its cross-process test on each target. Build the Docker `server` target for both `linux/amd64` and `linux/arm64`; test startup, listener conflicts, SIGTERM, read-only config mounts and writable storage on the actual target. A local single-platform build does not establish the other platform's result.
