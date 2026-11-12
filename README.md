# Zluggish

Zluggish is a self-hosted, open source server implementation of [Zwift](http://zwift.com) written in typescript that implements several features not available in the official app.

This project builds on [zwift-offline](https://github.com/zoffline/zwift-offline) and [its fork](https://github.com/fatsbrown/zwift-offline).

If you are migrating from the legacy zwift-offline app, please read the migration docs below.

## Features

Zluggish gives you complete control over the server, including the following features:

- **Offline play**: ride without having to communicate with Zwift servers
- **Choose any map**: ride wherever you want without being constrained by the official schedule
- **Your own ghosts**: ride alongside your previous efforts and regroup ghosts through chat
- **Custom RoboPacers and pelotons**: build pacers from recorded rides and add configurable followers, with control over group size, equipment, formation, and rider strength.
- **Saved-position bookmarks**: save named places during a ride, start another session from a bookmark, or return to one using in-game teleport.
- **Intervals.icu planned workouts**: bring scheduled workouts into the launcher and sync completed activities back to Intervals.icu. Exported TrainingPeaks `.zwo` workouts can also be imported through a local folder.
- **Local records and data**: keep profiles, activities, and recordings in storage you can back up and inspect, with optional all-time leaderboards for your server.
- **Equipment and progression control**: customize equipment availability and Drop balances on your own server, without grinding through unlocks.

Note that Zluggish is offline-only: there is no connection to Zwift's public multiplayer world. You cannot join riders on the official service, participate in its races, group rides, or club events, or compete on its global leaderboards. Local progression and records are separate from your official Zwift account. You can still ride with family or friends connected to your own Zluggish server using private multiplayer.

## Requirements

Zluggish requires technical know-how to set up. The **server** stores progress and runs ride services; the **client** is the device running the Zwift app. They can run on the same machine or separate machines on your local network.

### Server requirements

- Docker Compose is the recommended deployment method.
- Source installations require Node **24.15+ within 24.x** and pnpm **10**.
- Linux, Windows and macOS are target platforms; the TypeScript migration's full runtime verification matrix remains open.
- Keep the entire `storage/` directory across upgrades. It contains rider data, databases and encryption/signing keys.

### Client requirements

Windows and macOS are the primary supported clients. Android requires the advanced patching setup below. See Zwift's [official system requirements](https://support.zwift.com/en_us/supported-devices-to-run-zwift-H1Cj9QbeB). iPhone and iPad clients are not supported by this setup.

## Install

There are two main steps: start the Zluggish server, then configure Zwift to connect to it. If you are upgrading from legacy zwift-offline, first follow [Migration → Old storage](#old-storage).

### Step 1: Install and run Zluggish

<details open><summary>Docker Compose</summary>

Clone this repository and run from its root, replacing the address with the server's LAN IP:

```sh
docker compose up --build -d
docker compose logs -f zluggish
```

Compose builds `server/Dockerfile` using `server/` as its build context and mounts root `storage/` at `/usr/src/app/zwift-offline/storage`. It publishes TCP 80, 443 and 3025, UDP 3024, and optional DNS UDP 53. DNS is disabled by default. Allow the required ports through the server's local firewall.

The bundled container configuration is `server/examples/container/zluggish.config.ts`. To customize it, copy it to your own `zluggish.config.ts`, mount that file read-only, and select it with `ZLUGGISH_CONFIG`. For example, add these entries to the service in `docker-compose.yml`, retaining the existing storage mount:

```yaml
volumes:
  - ./storage/:/usr/src/app/zwift-offline/storage
  - ./zluggish.config.ts:/etc/zluggish/zluggish.config.ts:ro
environment:
  ZLUGGISH_CONFIG: /etc/zluggish/zluggish.config.ts
```

Set `storageDir: '/usr/src/app/zwift-offline/storage'` in an external container config; relative paths resolve against the config file's directory. Set `network.host: '0.0.0.0'` for container listeners. The image supplies bundled TLS certificates unless you configure replacements.

The `/etc/localtime` mount in the supplied Compose file uses the Linux host timezone. On Docker Desktop, remove that mount if unavailable and set `TZ` instead. `restart: unless-stopped` starts the service again after a host restart. Stop with `docker compose down`; retain `storage/` when upgrading.

</details>

<details><summary>Linux, Windows or macOS from source</summary>

Install Node 24 and pnpm 10, clone the repository, then run from its root:

```sh
pnpm --dir server install --frozen-lockfile
pnpm --dir cli install --frozen-lockfile
pnpm --dir cli build
pnpm --dir cli cli config validate
```

Edit `server/zluggish.config.ts` before connecting a real client. The checked-in config uses HTTP on loopback port 8787 for development. For normal client connections, use HTTPS 443 and the standard CDN/relay ports:

```ts
import { defineConfig } from 'zluggish/config';

export default defineConfig({
  storageDir: '../storage',
  server: { advertisedIp: '192.168.1.10' },
  network: { host: '0.0.0.0', api: { port: 443, useCert: true } },
});
```

Start and stop with:

```sh
pnpm --dir server start
# Press Ctrl+C when finished.
```

Binding ports 80 and 443 may require OS permissions on Unix; Docker handles those host port mappings for you. Use `--config` or `ZLUGGISH_CONFIG` for an external config. Paths inside it resolve relative to that file, so use an explicit storage path when moving it elsewhere.

This migration does not provide a Windows `zoffline.exe`. Upstream Python executables and their startup scripts are not launchers for this Node server.

</details>

Wait for the server to finish starting before opening Zwift. On fresh storage, open the printed first-rider setup link; account setup is described below.

### Configuration

Operator configuration is trusted executable TypeScript in **`zluggish.config.ts`**. It can export an object or a synchronous `defineConfig(({ env, configDir }) => (...))` function. Restart after editing it. No JSONC file is read or generated.

Config selection is `--config`, then `ZLUGGISH_CONFIG`, then `server/zluggish.config.ts`. There is no parent-directory discovery. Storage selection is `--storage-dir`, then `ZLUGGISH_STORAGE_DIR`, then the config's `storageDir`. The default config keeps rider data in root `storage/`.

Rider preferences and live group changes persist in SQLite rather than rewriting TypeScript. For example:

```sh
pnpm --dir cli cli settings show --user 42
pnpm --dir cli cli settings set --user 42 ghosts.enabled true
pnpm --dir cli cli settings reset --user 42 ghosts.enabled
```

See the [server guide](server/README.md) for config initialization, validation, typechecking and precedence.

### Step 2: Configure Zwift client to use Zluggish

<details><summary>Windows Instructions</summary>

- Install Zwift if not already installed
- **NOTE:** instead of performing the steps below you can instead just run the **configure_client** script from https://github.com/oldnapalm/zoffline-helper/releases/latest
- On your Windows machine running Zwift, copy the following files in this repo to a known location:
  - [server/assets/ssl/cert-zwift-com.p12](server/assets/ssl/cert-zwift-com.p12)
  - [server/assets/ssl/cert-zwift-com.pem](server/assets/ssl/cert-zwift-com.pem)
- Open Command Prompt as an admin, cd to that location and run
  - `certutil.exe -importpfx Root cert-zwift-com.p12`
  - If you're prompted for a password, just leave it blank. There is no password.
- Open Notepad as an admin and open `C:\Program Files (x86)\Zwift\data\cacert.pem`
  - Append the contents of `server/assets/ssl/cert-zwift-com.pem` to cacert.pem
- Open Notepad as an admin and open `C:\Windows\System32\Drivers\etc\hosts`
  - Append this line: `<server-ip> us-or-rly101.zwift.com secure.zwift.com cdn.zwift.com launcher.zwift.com`
    <br />(Where `<server-ip>` is the ip address of the machine running Zluggish. If
    it's running on the same machine as Zwift, use `127.0.0.1` as the ip.)
- The retained `scripts/configure_client.bat` helper configures local client redirection to `127.0.0.1`; use the manual steps above for a separate server. Older `launch.bat` scripts expect the removed Python/executable server and should not be used to start this Node version.

Why: We need to redirect Zwift to use Zluggish and convince Windows and Zwift to
accept Zluggish’s self signed certificates for Zwift's domain names. Feel free
to generate your own certificates and do the same.

</details>

<details><summary>macOS Instructions</summary>

- Install Zwift if not already installed
- On your Mac machine running Zwift, copy the file [server/assets/ssl/cert-zwift-com.pem](server/assets/ssl/cert-zwift-com.pem) in this repo to a known location.
- Open Keychain Access, select "System" under "Keychains", select "Certificates" under "Category"
  - Click "File - Import Items..." and import cert-zwift-com.pem
  - Right click "\*.zwift.com", select "Get Info" and under "Trust" choose "When using this certificate: Always Trust".
- From the cert-zwift-com.pem location, run `sed -n '29,53p' cert-zwift-com.pem >> ~/Library/Application\ Support/Zwift/data/cacert.pem`
- Using a text editor (with admin privileges) open `/etc/hosts`
  - Append this line: `<server-ip> us-or-rly101.zwift.com secure.zwift.com cdn.zwift.com launcher.zwift.com`
    <br />(Where `<server-ip>` is the ip address of the machine running Zluggish. If
    it's running on the same machine as Zwift, use `127.0.0.1` as the ip.)

Why: We need to redirect Zwift to use Zluggish and convince macOS and Zwift to
accept Zluggish’s self signed certificates for Zwift's domain names. Feel free
to generate your own certificates and do the same.

</details>

<details><summary>Android (non-rooted device)</summary>

- Install required apps:
  - Download and install `ZofflineObb.apk` from [here](https://github.com/fatsbrown/ZofflineObbAndroid/releases/latest)
  - Download and install `app-Github-release.apk` from [here](https://github.com/x-falcon/Virtual-Hosts/releases/latest)
  - Create a `hosts.txt` file to use with the app (you could use a text editor app or create it online with an online tool such as [this](https://passwordsgenerator.net/text-editor/)). The file must look like this (replace `<server-ip>` with the IP address of the machine running Zluggish):
    ```
    <server-ip> us-or-rly101.zwift.com
    <server-ip> secure.zwift.com
    <server-ip> cdn.zwift.com
    ```
  - Turn off "Private DNS" in Android settings
  - Run "Virtual Hosts" and select the created `hosts.txt` file
  - Optionally, instead of using the "Virtual Hosts" app, you can set `dns.enabled` to `true` in `zluggish.config.ts` and set the "DNS 1" of your phone Wi-Fi connection to the IP address of the PC running Zluggish
  - Note: If you know what you're doing and have a capable enough router you can adjust your router to alter these DNS records instead of using the "Virtual Hosts" app or changing your phone DNS.
- Patch after every installation or update:
  - Install/update Zwift from Google play, but do not start it yet.
    - If you have already started it go to `Android Settings > Applications > Zwift` and clear data or uninstall and reinstall the app.
  - Open the "ZofflineObb" app and run it (allow access to all files and install from unknown sources)
    - If the app doesn't work on your device, you can patch the OBB file on Windows. See [#505](https://github.com/zoffline/zwift-offline/issues/505) for details.
  - Wait for process to finish (5-10min)
  - Run Zwift, hopefully it verifies download and runs
- Play Zwift:
  - Virtual Hosts button must be ON
  - Create a local rider through the server setup page, set its local password, then sign in with the handle shown in Settings.

Why: We need to redirect Zwift to use Zluggish (this is done by the Virtual Hosts app) and convince Zwift to
accept Zluggish’s self signed certificates for Zwift's domain names (this is done by the patch tool ZofflineObb).

</details>

<details><summary>Android (rooted device)</summary>

- Install Zwift on the device
- Open Zwift once to complete installation (i.e download all extra files).
- Append the contents of `server/assets/ssl/cert-zwift-com.pem` to `/data/data/com.zwift.zwiftgame/dataES/cacert.pem` on the device
  - Note: this file will only exist after the first run of Zwift since it's downloaded after the initial install
  - Simple approach to achieve this if your device doesn't have a text editor:
    - `adb push server/assets/ssl/cert-zwift-com.pem /data/data/com.zwift.zwiftgame/dataES/`
    - In `adb shell`: `cd /data/data/com.zwift.zwiftgame/dataES/`
    - In `adb shell`: `cat cert-zwift-com.pem >> cacert.pem`
    - However you do it, ensure the permissions and ownership of the file remains the same.
- Modify the device's `/etc/hosts` file
  - Append this line: `<server-ip> us-or-rly101.zwift.com secure.zwift.com cdn.zwift.com`
    <br />(Where `<server-ip>` is the IP address of the machine running Zluggish.)
  - If no text editor on the device, recommend:
    - `adb pull /etc/hosts`
    - (modify on PC)
    - `adb push hosts /etc/hosts`
  - Note: If you know what you're doing and have a capable enough router you can adjust your router to alter these DNS records instead of modifying your `hosts` file.
- Create a local rider through the server setup page, set its local password, then sign in with the handle shown in Settings.

Why: We need to redirect Zwift to use Zluggish and convince Zwift to
accept Zluggish’s self signed certificates for Zwift's domain names. Feel free
to generate your own certificates and do the same.

</details>

#### Enabling/disabling client redirection

To use Zwift online like normal, comment out or remove the line added to the `hosts`
file before starting Zwift. Then ensure Zwift is fully closed (right click
the Zwift system tray icon and exit) and restart Zwift.

### Step 3 [OPTIONAL]: Import your official Zwift profile

Create/select the destination local rider first, then use **Import Zwift profile** on rider home or **Settings → Zwift**. Download selected data with official credentials, or upload previously exported `profile.bin`, `achievements.bin` and `economy_config.txt` files. The former Python `get_profile.py` helper has been removed; use the built-in import form.

Review the source name/ID and destination rider before confirming. Selected profile/progression, achievement and economy files replace those categories with backups; unselected categories and local activities stay unchanged. Imported names update both the picker and in-game profile unless **Keep local name** is selected. Imports preserve the local numeric ID, login password, role and folder. Reimport replaces progress rather than merging it. Duplicate/unknown source warnings require confirmation. Finish active rides before importing.

Official credentials do not become a local password and are not saved by importing. Uploads and Click authentication are separate opt-in connection settings. Importing does not fetch historical activities or enable ongoing synchronization. File imports do not prove official-account ownership.

Do not copy files blindly into `storage/<local-player-id>` or a folder named after the official player ID. Use the rider-targeted import form so files are validated and IDs/names are normalized. Official downloads need access to Zwift services; client redirection may need to be disabled on the machine used for official login.

### Step 4 [OPTIONAL]: Upload activities

Connections belong to the selected local rider. Completed activities are saved locally before uploads; one failing provider does not lose the saved activity. Live provider authorization and delivery still need verification for this TypeScript migration.

<details><summary>Strava</summary>

Two upload methods are available on **Settings → Strava**:

- **API application:** obtain a client ID and secret from [Strava API settings](https://www.strava.com/settings/api), set the authorization callback domain to `launcher.zwift.com`, save the credentials in the launcher and choose **Authorize with Strava**. Existing `storage/<local-player-id>/strava_token.txt` files are reused. API access depends on Strava's current application/account policy.
- **Browser session cookie:** sign in to Strava in a browser, open developer tools, find `_strava4_session` under Application/Storage → Cookies, and paste it into the rider's Strava settings. Select the session-cookie upload method and use **Test session**. Treat this cookie as a credential.

Screenshot upload uses the session-cookie method rather than the API. The old Python authorization helper is no longer needed or included.

</details>

<details><summary>Garmin Connect</summary>

Open **Settings → Garmin**, save the credentials and choose **Authorize with Garmin**. Enter the verification code if Garmin requests MFA. Authorization and FIT uploads now run in TypeScript; there is no Python helper or separate Garmin image.

Existing `oauth1_token.json` and `oauth2_token.json` files from garth can remain in `storage/<local-player-id>/garth/`. For a China account, set `integrations.garmin.domain: 'garmin.cn'` in operator config. Live Garmin login/upload remains a verification gate.

</details>

<details><summary>Intervals.icu and planned workouts</summary>

Open the selected rider's **Settings → Intervals** page. Copy the athlete ID and API key from [Intervals.icu settings](https://intervals.icu/settings), under Developer Settings, and save them there. Scheduled workouts appear in the launcher; completed activities can be uploaded and paired with their planned workout.

Exported TrainingPeaks `.zwo` files can be imported through a local bridge folder. Configure the rider's TrainingPeaks settings or `workouts.trainingpeaks.bridgeFolder` preference; paths must be accessible to the server, including inside Docker when used.

</details>

<details><summary>Official Zwift uploads and Runalyze</summary>

Official Zwift upload credentials and opt-in upload settings are separate from local passwords and profile import. Configure them for the selected rider in Settings. Click authentication is also a separate opt-in connection.

The Runalyze adapter reads the rider's existing `storage/<local-player-id>/runalyze_token.txt` file. Keep integration credentials private and preserve encryption keys when moving existing storage.

</details>

### Step 5 [OPTIONAL]: Install Zwift Companion App

<details><summary>Android (non-rooted device)</summary>

- Download and install the patched apk from [here](https://github.com/fatsbrown/zoffline-companion/releases/latest) (or [patch it yourself](https://github.com/fatsbrown/zoffline-companion#patch-it-yourself))
- Download and install `app-Github-release.apk` from [here](https://github.com/x-falcon/Virtual-Hosts/releases/latest)
- Create a `hosts.txt` file to use with the app (you could use a text editor app or create it online with an online tool such as [this](https://passwordsgenerator.net/text-editor/)). The file must look like this (replace `<server-ip>` with the IP address of the machine running Zluggish):

  ```
  <server-ip> us-or-rly101.zwift.com
  <server-ip> secure.zwift.com
  ```

  - Important: don't add `cdn.zwift.com` to `hosts.txt`, Companion needs to download images from the official server

- Turn off "Private DNS" in Android settings
- Run "Virtual Hosts" and select the created `hosts.txt` file
- Optionally, instead of using the "Virtual Hosts" app, you can set `dns.enabled` to `true` in `zluggish.config.ts` and set the "DNS 1" of your phone Wi-Fi connection to the IP address of the PC running Zluggish
- Note: If you know what you're doing and have a capable enough router you can adjust your router to alter these DNS records instead of using the "Virtual Hosts" app or changing your phone DNS.

</details>

### Rider accounts and household riding

Every installation uses local rider accounts, whether one person or several people ride. Each desktop launcher startup shows **Who’s riding?**, including when only one rider exists. Select a rider, choose ride options, then **Start Zwift**. **Switch rider** returns to the picker. Progress, workouts, ghosts, activities and integrations remain separate.

The account and activity database is `storage/zluggish.db`. Existing Zluggish databases named `zwift-offline.db` are renamed on startup; legacy databases are renamed after `accounts migrate` succeeds.

On a fresh installation, the launcher opens the **Add rider** screen directly. The same **Add rider** form is used for the first and later riders: enter a name and optionally a local password. The first rider is the owner/admin; later riders are regular accounts. An official Zwift account is optional. Without importing a profile, Zwift collects physical profile details when you first ride.

Riders with passwords show a password prompt when selected. Riders without passwords can be selected by anyone who can reach the server, including an owner left without a password. In **Settings → Local password**, add protection, or confirm the current password to change/remove it. Changing protection revokes previous sessions, including game refresh tokens. Local passwords are independent of official Zwift and integration credentials.

**Add rider** appears on the picker by default. Disable anonymous registration with `accounts.allowSelfRegistration: false` in `zluggish.config.ts` and restart; signed-in admins can still add riders. Duplicate display names are allowed; cards show rider numbers. Two devices can ride as different users concurrently. Starting another ride as a rider already active is rejected; switching the launcher does not stop an existing game.

Android uses native credential login, so set a local password for that rider and use the login handle shown in Settings. There is no passwordless native picker.

For a separate server, set `server.advertisedIp` and allow TCP 80, 443, 3025 and UDP 3024 on the local network. This enables private household riding, not access to Zwift’s public multiplayer world.

### Password recovery

Stop the server before using the recovery CLI. Put the new password in a private file, then run from the repository root:

```sh
pnpm --dir cli cli --storage-dir /path/to/storage accounts recover --user 1 --password-file /private/path/new-password.txt --admin
```

Remove the private password file after recovery. Omit `--admin` for password-only recovery. To remove password protection instead, use `--remove-password` without `--password-file`. The CLI revokes existing sessions. It does not prompt interactively for a password. Gmail/SMTP reset links are no longer supported.

### Step 6 [OPTIONAL]: Enable IPv6

Set `network.host: '::'` in `zluggish.config.ts`, or choose per-listener `host` values under `network.api`, `network.cdn`, `network.tcp` and `network.udp`. Configure a client-reachable `server.advertisedIp` and matching firewall/host mappings. IPv6 behavior still needs target-platform testing; the old `ZOFFLINE_SERVER_HOST` variable and Python `run_ipv6.bat` startup path are not used by Node.

## Migration

### Old storage

These instructions apply to legacy singleplayer and multiplayer installations. Fresh storage uses first-rider setup and does not need conversion.

1. Stop every server using the storage. Back up the entire `storage/` directory, including `zluggish.db` (or legacy `zwift-offline.db`), profiles, activities, preferences, credentials and signing/encryption keys. Keep the previous release/image for rollback.
2. Install and build the Node packages using the source instructions above. Start with a restored storage copy; do not run old and new servers against the same directory.
3. For original marker/text/INI/JSON configuration, migrate directly to TypeScript. Choose a new destination that does not already exist:

   ```sh
   pnpm --dir cli cli --storage-dir /path/to/storage config migrate --dry-run
   pnpm --dir cli cli --storage-dir /path/to/storage config migrate --output /path/to/zluggish.config.ts
   ```

   JSONC-only installations must recreate operator settings in `zluggish.config.ts` manually. Neither `storage/config.jsonc` nor the old JSONC example is loaded by this server. See the [typed config example](server/examples/zluggish.config.ts). Rider preference overrides are stored in `storage/settings.db`, not embedded in operator source.

4. Convert old accounts explicitly:

   ```sh
   pnpm --dir cli cli --storage-dir /path/to/storage accounts migrate
   pnpm --dir cli cli --config /path/to/zluggish.config.ts config validate
   pnpm --dir cli cli --config /path/to/zluggish.config.ts config typecheck
   ```

   Use `--solo-player 42` on account/config migration when the intended legacy solo profile needs an explicit choice. Use the local folder number, which may differ from an imported official player ID. The old `--settings-source` and `--server-dir` flags are not supported; resolve conflicting preferences explicitly before migration.

5. Inspect storage, IP, listener, TLS and credential paths in the generated config. Set `ZLUGGISH_CONFIG` or pass `--config` at startup. Inside Docker, mount config and storage and use their container paths. Re-select riders after startup and exercise ride/save/restart before switching production.

Config migration does not create accounts or modify the original activity database. Account migration is a separate offline operation with a database backup. Existing profile folders and numeric local IDs are retained. Ambiguous solo ownership and conflicting preference values are rejected instead of guessed. Existing usernames/password hashes are retained where supported; forgotten credentials can be reset through `accounts recover`.

A durable `.config-migration.json` journal makes config publication resumable. If interrupted, rerun the same command with the same destination; do not delete the journal or overwrite a subsequently edited config. Account database backups use `.accounts-<timestamp>.bak` suffixes. Preserve original marker/credential files until the migrated setup has been tested.

Rollback means stopping Node and restoring a matching pre-migration storage/config snapshot for the old release. Running an old binary against the new database is not rollback. Restoring an older snapshot discards subsequent progress; retain later FIT files separately. Follow the [cutover and rollback runbook](server/docs/cutover.md).

## Extra features

<details><summary>Ghosts</summary>

- Enable this feature by checking "Enable ghosts" in Zluggish’s launcher (if using Android, access the selected rider’s home page, check "Enable ghosts" and click "Start Zwift" to save the option).
- When you save an activity, the ghost will be saved in `storage/<player_id>/ghosts/<world>/<route>`. Next time you ride the same route, the ghost will be loaded.
- Type `.regroup` in chat to regroup the ghosts.
- Legacy ghost appearance settings used `storage/ghost_profile.txt`. The migration preserves its path as `ghosts.profileFile`, but current TypeScript playback uses the local rider profile and does not apply that override yet. The old `find_equip.py` helper is not included.

</details>

<details><summary>Bots</summary>

- Set `bots.enabled` to `true` in `zluggish.config.ts` to load ghosts as bots; they keep riding regardless of your route.
- Set `bots.multiplier` to an integer from 1 to 100 to duplicate bots. Large numbers can affect performance.
- Type `.group` in chat to group the bots, or `.groupall` to include duplicates (if using multiplier). Type `.autogroup` or `.autogroupall` to automatically group whenever you change roads. Type `.stopautogroup` to stop automatic grouping, or `.disperse` to randomize positions.
- Names, nationalities and equipment can be customized by creating a file `bot.txt` inside the `storage` folder. The former Python catalogue helper is not included; preserve an existing catalogue and set `bots.ridersFile` to its path in `zluggish.config.ts`.
- If you want some random bots, check [this repository](https://github.com/oldnapalm/zoffline-bots).

</details>

<details><summary>RoboPacers</summary>

- RoboPacers are ghosts saved using a power simulator, you can find some in [this repository](https://github.com/oldnapalm/zoffline-bots).
- The ghost must be recorded using update frequency of 1 second (default is 3 seconds).
- The activity must start and finish at the same position and speed, otherwise the bot won't loop smoothly.
- The profile must contain a unique player ID and the route ID, so that when you join the bot you take the same turns at intersections.
- Store each pacer’s `profile.bin` and `route.bin` in `storage/robopacers/<pacer-name>/`. The old Python `bot_editor.py` helper has been removed; use an existing compatible recording or external tooling to prepare its ID, route and loop.
- If you want to create a dynamic RoboPacer (increase power on climbs and decrease on descents) you can use [standalone_power.py](https://github.com/oldnapalm/zwift-offline/blob/master/standalone_power.py) (requires 2 ANT sticks, [python-ant](https://github.com/mch/python-ant) and [PowerMeterTx.py](https://github.com/oldnapalm/zwift-offline/blob/master/PowerMeterTx.py)).

</details>

<details><summary>Pelotons (RoboPacer + follower bots)</summary>

- A peloton is one RoboPacer followed by a custom group of bots riding in formation around and behind it, so joining the pacer feels like riding in a real group.
- Followers move up and back inside the group, drift laterally, stretch out on climbs (weaker riders lose some meters and come back on the flat), coast on descents and show realistic power (drafting), cadence and heart rate.
- Quick way: ride next to a RoboPacer and type `.peloton 20` in chat (`.peloton` shows the current size, `.peloton off` removes it). Chat changes persist as SQLite overrides; they do not rewrite `zluggish.config.ts`.
- Or add a `pelotons` array to `zluggish.config.ts`. Each entry needs a stable `id` and a `pacer` (the folder name inside `storage/robopacers` or its player ID). Other fields have defaults:

```ts
import { defineConfig } from 'zluggish/config';

export default defineConfig({
  pelotons: [
    {
      id: 'volcano-group',
      pacer: 'B - 3.3 WKG - Watopia - Volcano Climb',
      bots: 25,
      columns: 0,
      rowGap: 2.2,
      lateralSpacing: 65000,
      besidePacer: 2,
      dynamics: 1,
      shuffleInterval: 30,
      draft: 0.7,
      climbStretch: 1,
      maxDrop: 40,
      riders: [
        { firstName: 'Tadej', lastName: 'Pogacar', countryCode: 705, isMale: true, position: 'front', strength: 1.3 },
        { firstName: 'Ana', lastName: 'Lopez', isMale: false, weight: 55, position: 'back', strength: 0.85 },
      ],
    },
  ],
});
```

- `bots`: total followers (max 200). Riders not listed in `riders` get random names (from the `bots.ridersFile` catalogue when configured) and random equipment.
- `columns`: max width of the group (0 = automatic). `rowGap`: meters between rows. `lateralSpacing`: lateral distance between riders in `roadPosition` units (100000 = 1 meter, default 0.65 m). `besidePacer`: riders alongside the pacer.
- `dynamics`: 0 = rigid formation, 1 = normal, 2 = very lively. `shuffleInterval`: average seconds between position changes. `draft`: fraction of power used by a rider on a wheel. `climbStretch` and `maxDrop`: how much the group stretches on climbs.
- Each rider in `riders` uses camelCase profile fields such as `firstName`, `lastName`, `countryCode`, `bikeFrame` and `rideJersey`, plus `position` (`front`, `middle`, `back` or `any`), `strength` (0.5 - 1.5), `weight` (kg), `height` (cm), `cadence` (rpm) and `maxHeartRate`.
- Restart after editing operator config; it is not watched for changes. Set `enabled: false` to disable a configured peloton without deleting it. Live chat overrides remain in SQLite.

</details>

<details><summary>Solo blob</summary>

- Solo peloton "blob" is a group of bots that swarm around the player, in real time - no RoboPacer needed.
- The bots ride the actual trail you just rode (real corners, hills and speed), sit wheel to wheel behind you to use the draft, mix and rotate: somebody comes up to your handlebars, pulls for a while, then drifts back through the group and somebody else takes over.
- Chat commands:
  - `.blob <n>` - start/keep a blob of n riders around you
  - `.blob` - show status
  - `.blob new` - same number of riders, new faces
  - `.blob off` - stop
- Gestures (F-keys) that move the group:
  - Elbow (F1) - come and pass me
  - Hammertime (F4) - full gas, segment on
  - I'm toast (F7) - easing off
  - Bell (F8) - I want a turn in front

</details>

<details><summary>Bookmarks</summary>

- When you finish an activity, your last position will be saved as a bookmark.
- Bookmarks can also be saved using the command `.bookmark <name>` in the chat.
- You can start a new activity from a bookmark by selecting it in "Join a Zwifter" on the home screen.
- You can teleport to a bookmark using the teleport icon on the action bar.

</details>

<details><summary>All-time leaderboards</summary>

- To enable all-time leaderboards (override 60 minutes live results and 90 days personal records), set `leaderboards.allTime` to `true` in `zluggish.config.ts`.
- Jerseys are still valid for 60 minutes but will be granted only when a new all-time record is set.

</details>

<details><summary>Entitlements</summary>

- To unlock entitlements (special equipment), set `equipment.unlockEntitlements` to `true` in `zluggish.config.ts`.
- To unlock all equipment, set `equipment.unlockAll` to `true` instead.

</details>

<details><summary>CDN proxy</summary>

- `proxy.mode` accepts `'auto'` (default), `'enabled'` or `'disabled'` in `zluggish.config.ts`.
- Bundled files are served from `server/assets/cdn/`. Missing game assets can be requested from Zwift through the proxy; upstream resolution uses Google public DNS independently of client host redirects. Use `'disabled'` for local-only assets. Live proxy behavior remains part of manual verification.
- The former `get_gameassets.py` downloader is no longer included. Preserve any existing asset cache under the new CDN asset directory and rebuild the image after changing bundled files.

</details>

<details><summary>Discord bridge</summary>

The bridge runs in the Node server, including Docker. Create a private `storage/discord.cfg` file:

```ini
[discord]
token = YOUR_BOT_TOKEN
webhook = YOUR_CHANNEL_WEBHOOK_URL
```

Then configure operator settings, using a path relative to the config file (this example assumes `server/zluggish.config.ts`):

```ts
import { defineConfig } from 'zluggish/config';

export default defineConfig({
  integrations: {
    discord: {
      enabled: true,
      credentialsFile: '../storage/discord.cfg',
      channel: '123456789012345678', // Replace with your channel ID.
      welcomeMessage: 'Welcome!',
      helpMessage: 'Ride with us on the local server.',
      announcePlayers: true,
    },
  },
});
```

Enable guild-member and message-content intents for the bot. The bridge supports configured-channel chat, welcome and join/leave announcements, online presence, and `!online`, `!ping` and `!help` commands. Keep tokens/webhooks private. Live gateway and webhook delivery still need verification with a test guild.

</details>

## Community Discord server and Strava club

Please join the community supported [Discord](https://discord.gg/GMdn8F8) server and [Strava](https://www.strava.com/clubs/zoffline) club.

## Dependencies

Use Docker, or Node 24 and pnpm 10 for a source installation. Runtime dependencies include Hono and its Node adapter, protobuf codecs, SQLite through Node's built-in module, native OS storage locks, Zod, Jiti, the Garmin FIT/Connect libraries and discord.js. Package manifests and lockfiles in `server/` and `cli/` are authoritative. No Python runtime or pip dependencies are required.

## Note

Future Zwift updates can break compatibility. Client redirection can interfere with normal updates; switch back to the official service before updating, then recheck compatibility. See [CHANGELOG](CHANGELOG) for changes that may require operator action.

Keep Zluggish on a trusted local network; it is not designed for public Internet exposure.

<details><summary>If Zluggish is behind the official client</summary>
Updating the advertised client version may let a newer client start, but does not establish protocol compatibility.

- Windows: copy `C:\Program Files (x86)\Zwift\Zwift_ver_cur.xml` to Zluggish's `server/assets/cdn/gameassets/Zwift_Updates_Root/` overwriting the existing file.
- macOS: copy `~/Library/Application Support/Zwift/ZwiftMac_ver_cur.xml` to Zluggish's `server/assets/cdn/gameassets/Zwift_Updates_Root/` overwriting the existing file.
- Linux/server-only deployments: obtain the version XML from the client installation and place it in the same `server/assets/cdn/gameassets/Zwift_Updates_Root/` directory. Historical upstream version-update helpers assume the old directory layout.

There is no guarantee that an untested Zwift update will work. Rebuild the Docker image after updating bundled assets, and verify client compatibility before changing a working installation.

Alternatively, [this script](https://gist.github.com/oldnapalm/556c58448a6ee09438b39e1c1c9ce3d0) can be used to downgrade Zwift to the version supported by your server.

</details>

<details><summary>Update failed during patching</summary>

If you get this error even though Zluggish is up to date, rename the file `Zwift_ver_cur.<version>.xml` in Zwift directory to `Zwift_ver_cur.xml` and edit the file `Zwift_ver_cur_filename.txt` accordingly.

</details>

## Development

Install [mise](https://mise.jdx.dev/getting-started.html), then run from the repository root:

```sh
cd cli
mise install
mise run install
mise run check
```

Mise manages Node 24 and pnpm 10. Its configuration and tasks are in `cli/mise.toml`. The check task builds both packages, runs ESLint and anti-slop Oxlint rules, typechecks, runs server and CLI tests, and checks formatting. Use `mise run server-dev` for the development server, `mise run test` for tests, or `mise run format-fix` to format supported files. Generated protobuf codecs and bundled assets are excluded from lint/format checks.

For individual pnpm commands and lint provenance, see the [CLI/tooling guide](cli/README.md) and [lint documentation](server/docs/linting.md).

## Legal notice

Zluggish is an independent, community-developed project. It is **not affiliated with, endorsed by, sponsored by, or officially supported by Zwift, Inc.** Zwift is a trademark of Zwift, Inc. Other product and company names belong to their respective owners; references to them do not imply affiliation or endorsement.

Zluggish is licensed under the **GNU Affero General Public License, version 3 (AGPL-3.0)**. See [LICENSE](LICENSE) for the full terms, including the warranty disclaimer. Third-party components retain their respective licenses and copyright notices. This license does not grant rights to Zwift's proprietary client, game assets, or trademarks.

This project is based on [zwift-offline](https://github.com/zoffline/zwift-offline) and [fatsbrown's fork of zwift-offline](https://github.com/fatsbrown/zwift-offline). Credit for that foundation belongs to their authors and contributors.
