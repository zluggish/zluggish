# Compatibility and implementation status

The TypeScript server now registers every inventoried HTTP route, the live TCP/UDP/DNS/CDN listeners, and the ride simulation, but it is **not** a verified Python replacement. The default Docker/Compose deployment now runs Node. The TypeScript server still reports `rideReady: false` because no supported real client has ridden against it.

## Established

- One package under `server/`, Hono `^4.0.0` (currently resolved to 4.13.18), Node adapter 2.1.8, Node 24, pnpm lockfile, strict TypeScript, and all generic anti-slop rules at error severity. Anti-slop source identity/licenses are recorded in its vendored directory.
- `zluggish.config.ts`: typed object/factory authoring, runtime validation, explicit environment handling, config-relative paths, deep read-only resolved values, external helper/module resolution without a local `node_modules`, and editable mounted configs without rebuilding. No JSONC runtime dependency or format migration.
- Direct original marker/INI/JSON migration into typed TS and `settings.db`. Existing account/progress database remains unchanged. Conflict checks, true dry runs, credential references, explicit solo mapping, backup, durable journal, activation-last publication, and idempotent recovery are exercised.
- SQLite preference overlay precedence and reset semantics; write commands share an OS lock with the Python reference. Native `flock`/`LockFileEx` calls hold the lock; no Python lock bridge is used.
- Generated codecs from all 20 unchanged canonical proto2 definitions. Required fields are enforced on serialization (like Python, decoding alone is not a required-field validation gate). Tests preserve maximum signed 64-bit profile ID, explicit false presence, and unknown field 500 through known-field edits.
- Python-produced deterministic crypto vectors cover all eight relay/connection/sequence header combinations. Node output matches byte-for-byte; the legacy unauthenticated receive behavior is preserved explicitly rather than mislabeled as AEAD verification.
- Fragmented/coalesced TCP frame decoding, bounded incomplete-frame storage, credential CFB8 compatibility, Werkzeug scrypt/legacy SHA-256 verification, and Flask-Login identity signatures are tested.
- Hono serves game metadata and machine feature variants. A real ephemeral loopback HTTPS test verifies binary bodies, multipart forms, and the actual socket address despite a forged forwarded-IP header.

## Deliberate differences and open gates

The operator config format, field names, reload model, preference persistence and CLI config editing contract intentionally differ from Python. Existing JSONC files are ignored. Chat commands persist live blob and peloton overrides in SQLite. These differences are documented in the server README.

The new preferences database is a separately versioned sidecar (`user_version=1`); this avoids altering the existing schema-4 rider database during the compatibility spike. A future runtime must keep one owner for world state and preserve atomicity across any additional persistence boundaries. Read-only/inspection operations do not silently initialize databases.

The runtime and all integrations are TypeScript; native OS locking requires no Python process. OS-lock interoperability is verified locally and exercised by the CI matrix; Windows/Linux CI results are not equivalent to having been run locally.

The full route inventory is generated in `legacy-inventory.json` (201 decorators and 16 models). `tests/inventory.test.ts` fails if a legacy route has no matching Hono route, so the inventory cannot silently drift. Deliberate differences:

- State-changing Flask `GET` routes (`/restart`, `/cancelrestart`, `/reloadbots`, `/delete/<file>`, and the Intervals.icu/TrainingPeaks `/sync` actions) are CSRF-protected `POST` forms here. Links that issued a `GET` return 404.
- `/authorization` (Strava OAuth callback) requires the `state` issued by `/strava_auth`, bound to the browser's CSRF token. A callback that did not start in this browser is refused.
- `/api/d-lock-service/device/authenticate` forwards only content type, accept and the official bearer token to Zwift; the Python server forwarded every inbound header including local cookies.
- Launcher pages are server-rendered Hono HTML, not the Jinja templates. Secrets (Strava client secret and cookie, Garmin password) are never rendered back into forms.
- `/player-playback/playbacks/<file>` serves only the `<uuid>.playback` names this server writes.

## Integration capability matrix

| Capability                                                  | Status                                                                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intervals.icu workout sync and activity upload with pairing | Ported. Paired workout and its cached `.zwo` are removed after a successful upload.                                                                           |
| TrainingPeaks                                               | Local export-folder bridge only; automatic API access needs partner credentials.                                                                              |
| Strava, API method                                          | Ported (token file format unchanged, refresh before upload).                                                                                                  |
| Strava, free (session cookie) method                        | Ported, including photos and edit-form updates. Depends on Strava's current web pages.                                                                        |
| Runalyze                                                    | Ported (`runalyze_token.txt`).                                                                                                                                |
| Official Zwift upload and Zwift Click device authentication | Ported; the activity is uploaded with the stored official credentials and `uploads.zwift.enabled`.                                                            |
| Garmin Connect                                              | TypeScript client with existing garth-format token files, login/MFA and FIT import. No Python helper. Live-service checks remain unverified.                  |
| Discord bridge                                              | Ported: chat in both directions, commands, welcome messages, presence and rider announcements. Disabled by default; live credentials have not been exercised. |

Uploads run detached after the activity is saved. One failing or offline service never blocks the others or loses the activity, and no upload is retried automatically, so a provider cannot receive a duplicate.

Current vectors are synthetic, not packet captures from supported clients. JSON endpoint-specific numeric conversions, real-client packet/sequence edge cases, full feature coverage, performance under bot loads, and long-ride durability remain release gates. No performance claim or real-client ride compatibility is established by the current tests.

## Remaining release gates

- Real-client verification: ride on a supported desktop client, save, restart, and continue; replay hills, turns, teleports, reconnects and long rides against recorded Python baselines.
- Performance under four concurrent blobs and large pelotons, with event-loop delay, tick duration and memory measured against Python on the same hardware.
- Linux/macOS/Windows cutover runbook, Docker amd64/arm64 verification, backup/restore rehearsal, and native storage lock validation on each target platform.
- Live checks of Strava, Intervals.icu, Runalyze, Zwift and Garmin with configured accounts. Tests use stubbed network responses only.
- Verify Discord gateway intents and webhook delivery using an explicitly configured test guild.

## Source layout

The retained Python implementation, codecs, old CLI/config, packaging, utilities and Python CI setup have been removed at the user's request before manual testing. Historical sources remain in Git revision `6940d4f`; captured protocol vectors and route inventories remain data fixtures. The server package, integrations and verification tooling run entirely on Node. Route registration coverage does not establish behavioral parity.
