# zluggish

Zluggish is a self-hosted, open source server implementation of [Zwift](http://zwift.com) that implements several features not available in the official app.

This project builds on [zwift-offline](https://github.com/zoffline/zwift-offline) and [its fork](https://github.com/fatsbrown/zwift-offline).

If you are migrating from the legacy zwift-offline app, please read the migration docs below.

## Features

Zluggish gives you complete control over the server, including the following features:

- **Offline play**: ride without having to communicate with Zwift servers
- **Choose any map**: ride wherever you want without being constrained by the official schedule
- **Your own ghosts**: ride alongside your previous efforts, regroup ghosts through chat, and customize their appearance
- **Custom RoboPacers and pelotons**: build pacers from recorded rides and add configurable followers, with control over group size, equipment, formation, and rider strength.
- **Saved-position bookmarks**: save named places during a ride, start another session from a bookmark, or return to one using in-game teleport.
- **Intervals.icu planned workouts**: bring scheduled workouts into the launcher and sync completed activities back to Intervals.icu. Exported TrainingPeaks `.zwo` workouts can also be imported through a local folder.
- **Local records and data**: keep profiles, activities, and recordings in storage you can back up and inspect, with optional all-time leaderboards for your server.
- **Equipment and progression control**: customize equipment availability and Drop balances on your own server, without grinding through unlocks.

Note that Zluggish is offline-only: there is no connection to Zwift's public multiplayer world. You cannot join riders on the official service, participate in its races, group rides, or club events, or compete on its global leaderboards. Local progression and records are separate from your official Zwift account. You can still ride with family or friends connected to your own Zluggish server using private multiplayer.

## Development

Install [mise](https://mise.jdx.dev/getting-started.html), then run:

```sh
mise install
mise run install
mise run check
```

Mise manages Python 3.12, Node, pnpm, Ruff and Prettier, and creates a local `.venv` for Python dependencies. The existing `requirements.txt` remains the source for application dependencies. Run `mise run test` for tests, `mise run lint` for Python checks, or `mise run format-fix` to format supported files. `mise run format` checks formatting without changing files. Generated protobuf files and bundled data are excluded from these checks.

## Requirements

**Zluggish requires a technical setup**, so you have to be comfortable with that to use it.

The **server** stores your progress and runs the ride services while the **client** is the device running the Zwift app and displaying the ride. In many cases the server and client can be on the same machine.

### Server requirements

- Windows, Linux and macOS are supported
- Docker is the recommended deployment method

### Client requirements

Windows and macOS is recommended for the client, but Android is an advanced option that requires manual app patching.

In addition, you must fulfill the [official system requirements](https://support.zwift.com/en_us/supported-devices-to-run-zwift-H1Cj9QbeB).

Note that iPhone and iPad are not supported clients: iOS and iPados are too locked dowh.

## Install

Setting up zoffline requires two primary steps. First, zoffline must be installed and run on a system before running Zwift (either on the system running Zwift or on another locally networked system). Second, Zwift must be configured to use zoffline instead of the official Zwift server.

For a fresh installation, create `storage/config.jsonc` before starting the server (or copy `examples/config.jsonc`):

```json
{ "config_version": 1 }
```

For existing storage, follow [Migration → Old storage](#old-storage). After configuring the client, use the server's printed setup link to create your first rider.

### Step 1: Install zoffline

There are four ways with which to install and run zoffline depending on your platform:

<details><summary>Simplest (Windows only)</summary>
To install zoffline on Windows:

- Download the latest zoffline release from https://github.com/fatsbrown/zwift-offline/releases/latest
- If you are not running zoffline on the same PC that Zwift is running: set `server.advertised_ip` in `storage/config.jsonc` to the IP address of the PC running zoffline.
- Run the downloaded zoffline.exe
  - Once run, zoffline will create a `storage` directory in the same folder it's in to store your Zwift progress.
- Start Zwift with zoffline.exe running (**after completing step 2** or running **configure_client** script from https://github.com/oldnapalm/zoffline-helper/releases/latest)
  - It takes zoffline a few seconds to start. Wait until text appears in the command prompt before opening Zwift.
- When done with Zwift, press Ctrl+C in the command line to close zoffline.
</details>

<details><summary>Linux, Windows, or macOS (from source)</summary>
To install zoffline on Linux, Windows, or macOS:

- Install Python 3 (https://www.python.org/downloads/) if not already installed
  - On Windows, installing Python via the Microsoft Store is highly recommend! If using a Python installer, ensure that in the first Python installer screen "Add Python 3.x to PATH" is checked.
- Clone or download this repo
- Install dependencies
  - e.g., on Linux/Mac: `pip3 install -r requirements.txt`
  - e.g., on Windows in command prompt: `pip install -r requirements.txt`
    - You may need to use `C:\Users\<username>\AppData\Local\Programs\Python\Python<version>\Scripts\pip.exe` instead of just `pip`
- If you are not running zoffline on the same PC that Zwift is running: set `server.advertised_ip` in `storage/config.jsonc` to the IP address of the PC running zoffline.
- Run standalone.py before starting Zwift
  - e.g., on Linux/Mac: `sudo ./standalone.py`
    - sudo is needed because we're binding to the privileged ports 80 and 443.
    - If Python 3 is not your system default run `sudo python3 standalone.py`
  - e.g., on Windows in command prompt: `python standalone.py`
    - You may need to use `C:\Users\<username>\AppData\Local\Programs\Python\Python<version>\python.exe` instead of just `python`
- Start Zwift with standalone.py running (**after completing step 2**)
- Note: When upgrading zoffline, be sure to retain the `storage` directory. It contains your Zwift progress state.

zoffline can be installed on the same machine as Zwift or another local machine.

</details>

<details><summary>Using Docker</summary>
 
* Install Docker
* Create the docker container with:<br>
  ``docker create --name zluggish -p 443:443 -p 80:80 -p 3024:3024/udp -p 3025:3025 -p 53:53/udp -v </path/to/host/storage>:/usr/src/app/zwift-offline/storage -e TZ=<timezone> ghcr.io/zluggish/zluggish``
  * You can optionally exclude ``-v </path/to/host/storage>:/usr/src/app/zwift-offline/storage`` if you don't care if your Zwift progress state is retained across zoffline updates (unlikely).
  * The path you pass to ``-v`` will likely need to be world readable and writable.
  * A list of valid ``<timezone>`` values (e.g. America/New_York) can be found [here](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).
  * Adding ``--restart unless-stopped`` will make zoffline start on boot if you have Docker v1.9.0 or greater.
* If you are not running zoffline on the same PC that Zwift is running: set `server.advertised_ip` in the mounted `config.jsonc` to the IP address of the PC running zoffline.
* Start zoffline with:
  ``docker start zluggish``
</details>

<details><summary>Using Docker Compose</summary>

- Install docker-compose
- Either use the `docker-compose.yml` file in this repo which will build from the Dockerfile, or use this example compose file:

  ```yaml
  services:
    zluggish:
      image: ghcr.io/zluggish/zluggish:latest
      container_name: zluggish
      volumes:
        - /etc/localtime:/etc/localtime:ro
        - ./storage/:/usr/src/app/zwift-offline/storage
      ports:
        - 80:80
        - 443:443
        - 3024:3024/udp
        - 3025:3025
      restart: unless-stopped
  ```

  - The `/etc/localtime` mount uses the host timezone on Linux. On Docker Desktop, set a `TZ` environment variable if the mount is unavailable or reflects the Docker VM timezone.
  - In the `volumes` tag replace `./storage/` before the `:` with the directory path you want to use as your local zoffline data store.

- If you are not running zoffline on the same PC that Zwift is running: set `server.advertised_ip` in `storage/config.jsonc` to the IP address of the PC running zoffline.
- Start zoffline with: `docker-compose up -d`
</details>

### Step 2: Configure Zwift client to use zoffline

<details><summary>Windows Instructions</summary>

- Install Zwift if not already installed
- **NOTE:** instead of performing the steps below you can instead just run the **configure_client** script from https://github.com/oldnapalm/zoffline-helper/releases/latest
- On your Windows machine running Zwift, copy the following files in this repo to a known location:
  - [ssl/cert-zwift-com.p12](https://github.com/zoffline/zwift-offline/raw/master/ssl/cert-zwift-com.p12)
  - [ssl/cert-zwift-com.pem](https://github.com/zoffline/zwift-offline/raw/master/ssl/cert-zwift-com.pem)
- Open Command Prompt as an admin, cd to that location and run
  - `certutil.exe -importpfx Root cert-zwift-com.p12`
  - If you're prompted for a password, just leave it blank. There is no password.
- Open Notepad as an admin and open `C:\Program Files (x86)\Zwift\data\cacert.pem`
  - Append the contents of `ssl/cert-zwift-com.pem` to cacert.pem
- Open Notepad as an admin and open `C:\Windows\System32\Drivers\etc\hosts`
  - Append this line: `<zoffline ip> us-or-rly101.zwift.com secure.zwift.com cdn.zwift.com launcher.zwift.com`
    <br />(Where `<zoffline ip>` is the ip address of the machine running zoffline. If
    it's running on the same machine as Zwift, use `127.0.0.1` as the ip.)
- If you wish to leave the `hosts` file unchanged except for when specifically using zoffline, you may optionally use the **launch.bat** script within the `scripts` directory to launch zoffline instead of using the normal Zwift Launcher. See [#121](https://github.com/zoffline/zwift-offline/issues/121) for details.

Why: We need to redirect Zwift to use zoffline and convince Windows and Zwift to
accept zoffline's self signed certificates for Zwift's domain names. Feel free
to generate your own certificates and do the same.

</details>

<details><summary>macOS Instructions</summary>

- Install Zwift if not already installed
- On your Mac machine running Zwift, copy the file [ssl/cert-zwift-com.pem](https://github.com/zoffline/zwift-offline/raw/master/ssl/cert-zwift-com.pem) in this repo to a known location.
- Open Keychain Access, select "System" under "Keychains", select "Certificates" under "Category"
  - Click "File - Import Items..." and import cert-zwift-com.pem
  - Right click "\*.zwift.com", select "Get Info" and under "Trust" choose "When using this certificate: Always Trust".
- From the cert-zwift-com.pem location, run `sed -n '29,53p' cert-zwift-com.pem >> ~/Library/Application\ Support/Zwift/data/cacert.pem`
- Using a text editor (with admin privileges) open `/etc/hosts`
  - Append this line: `<zoffline ip> us-or-rly101.zwift.com secure.zwift.com cdn.zwift.com launcher.zwift.com`
    <br />(Where `<zoffline ip>` is the ip address of the machine running zoffline. If
    it's running on the same machine as Zwift, use `127.0.0.1` as the ip.)

Why: We need to redirect Zwift to use zoffline and convince macOS and Zwift to
accept zoffline's self signed certificates for Zwift's domain names. Feel free
to generate your own certificates and do the same.

</details>

<details><summary>Android (non-rooted device)</summary>

- Install required apps:
  - Download and install `ZofflineObb.apk` from [here](https://github.com/fatsbrown/ZofflineObbAndroid/releases/latest)
  - Download and install `app-Github-release.apk` from [here](https://github.com/x-falcon/Virtual-Hosts/releases/latest)
  - Create a `hosts.txt` file to use with the app (you could use a text editor app or create it online with an online tool such as [this](https://passwordsgenerator.net/text-editor/)). The file must look like this (replace `<zoffline ip>` with the IP address of the machine running zoffline):
    ```
    <zoffline ip> us-or-rly101.zwift.com
    <zoffline ip> secure.zwift.com
    <zoffline ip> cdn.zwift.com
    ```
  - Turn off "Private DNS" in Android settings
  - Run "Virtual Hosts" and select the created `hosts.txt` file
  - Optionally, instead of using the "Virtual Hosts" app, you can set `dns.enabled` to `true` in `storage/config.jsonc` and set the "DNS 1" of your phone Wi-Fi connection to the IP address of the PC running zoffline
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

Why: We need to redirect Zwift to use zoffline (this is done by the Virtual Hosts app) and convince Zwift to
accept zoffline's self signed certificates for Zwift's domain names (this is done by the patch tool ZofflineObb).

</details>

<details><summary>Android (rooted device)</summary>

- Install Zwift on the device
- Open Zwift once to complete installation (i.e download all extra files).
- Append the contents of `ssl/cert-zwift-com.pem` to `/data/data/com.zwift.zwiftgame/dataES/cacert.pem` on the device
  - Note: this file will only exist after the first run of Zwift since it's downloaded after the initial install
  - Simple approach to achieve this if your device doesn't have a text editor:
    - `adb push ssl/cert-zwift-com.pem /data/data/com.zwift.zwiftgame/dataES/`
    - In `adb shell`: `cd /data/data/com.zwift.zwiftgame/dataES/`
    - In `adb shell`: `cat cert-zwift-com.pem >> cacert.pem`
    - However you do it, ensure the permissions and ownership of the file remains the same.
- Modify the device's `/etc/hosts` file
  - Append this line: `<zoffline ip> us-or-rly101.zwift.com secure.zwift.com cdn.zwift.com`
    <br />(Where `<zoffline ip>` is the IP address of the machine running zoffline.)
  - If no text editor on the device, recommend:
    - `adb pull /etc/hosts`
    - (modify on PC)
    - `adb push hosts /etc/hosts`
  - Note: If you know what you're doing and have a capable enough router you can adjust your router to alter these DNS records instead of modifying your `hosts` file.
- Create a local rider through the server setup page, set its local password, then sign in with the handle shown in Settings.

Why: We need to redirect Zwift to use zoffline and convince Zwift to
accept zoffline's self signed certificates for Zwift's domain names. Feel free
to generate your own certificates and do the same.

</details>

#### Enabling/Disabling zoffline

To use Zwift online like normal, comment out or remove the line added to the `hosts`
file before starting Zwift. Then ensure Zwift is fully closed (right click
the Zwift system tray icon and exit) and restart Zwift.

### Step 3 [OPTIONAL]: Import your official Zwift profile

Create/select the destination local rider first, then use **Import Zwift profile** on rider home or **Settings → Zwift**. Download selected data with official credentials, or choose exported `profile.bin`, `achievements.bin` and `economy_config.txt` files from `scripts/get_profile.py -u <official_username>`.

Review the source name/ID and destination rider before confirming. Selected profile/progression, achievement and economy files replace those categories with backups; unselected categories and local activities stay unchanged. Imported names update both the picker and in-game profile unless **Keep local name** is selected. Imports preserve the local numeric ID, login password, role and folder. Reimport replaces progress rather than merging it. Duplicate/unknown source warnings require confirmation. Finish active rides before importing.

Official credentials do not become a local password and are not saved by importing. Uploads and Click authentication are separate opt-in connection settings. Importing does not fetch historical activities or enable ongoing synchronization. File imports do not prove official-account ownership.

Do not copy files blindly into `storage/<local-player-id>` or a folder named after the official player ID. Use the rider-targeted import form so files are validated and IDs/names are normalized. The helper requires access to official Zwift services; temporarily disable client redirection when exporting if necessary.

### Step 4 [OPTIONAL]: Upload activities

<details><summary>Strava</summary>

- Two upload methods are available and can be selected on the "Settings - Strava" page of the launcher (if using Android, access the selected rider’s Settings page):
  - **API application (requires an active paid subscription):**
    - Get CLIENT_ID and CLIENT_SECRET from https://www.strava.com/settings/api
    - **NOTE:** instead of performing the steps below you can instead set the authorization callback domain of your API application to `launcher.zwift.com` and use the "Settings - Strava" page of the launcher (Windows and macOS only).
    - Run `scripts/strava_auth.py --client-id CLIENT_ID --client-secret CLIENT_SECRET`
      - Or, if using the Windows zoffline.exe version without Python installed you can run `strava_auth.exe` obtained from https://github.com/oldnapalm/zoffline-helper/releases/latest in place of `scripts/strava_auth.py`
    - Open http://localhost:8000/ and authorize.
    - Move the resulting `strava_token.txt` (saved in whatever directory you ran `strava_auth.py` in) into the `storage/<local-player-id>` directory.
  - **Browser session cookie (free):**
    - Log in to https://www.strava.com in a browser, open the developer tools (F12), navigate to "Application - Storage - Cookies" and copy the `_strava4_session` cookie value.
    - Paste and save the value on the "Settings - Strava" page of the launcher.
- Automatic screenshots uploading works with the session cookie method, but not with the API. See [#28](https://github.com/zoffline/zwift-offline/issues/28) for details.

</details>

<details><summary>Garmin Connect</summary>

- **NOTE:** Garmin Connect login is no longer supported ([matin/garth#222](https://github.com/matin/garth/discussions/222)).
- Use [this script](https://gist.github.com/coleman8er/5c8e192d2aa3c8a3a6220c5702e8a5e6) to login and save tokens.
- Move the resulting `oauth1_token.json` and `oauth2_token.json` from `~/.garth` (`C:\Users\<username>\.garth`) to `storage/<local-player-id>/garth`.

</details>

<details><summary>Intervals.icu</summary>

- Use the "Settings - Intervals" button in the launcher window to enter your credentials (if using Android, access the selected rider’s Settings page).
- Copy "Athlete ID" and "API Key" from https://intervals.icu/settings under "Developer Settings".

</details>

### Step 5 [OPTIONAL]: Install Zwift Companion App

<details><summary>Android (non-rooted device)</summary>

- Download and install the patched apk from [here](https://github.com/fatsbrown/zoffline-companion/releases/latest) (or [patch it yourself](https://github.com/fatsbrown/zoffline-companion#patch-it-yourself))
- Download and install `app-Github-release.apk` from [here](https://github.com/x-falcon/Virtual-Hosts/releases/latest)
- Create a `hosts.txt` file to use with the app (you could use a text editor app or create it online with an online tool such as [this](https://passwordsgenerator.net/text-editor/)). The file must look like this (replace `<zoffline ip>` with the IP address of the machine running zoffline):

  ```
  <zoffline ip> us-or-rly101.zwift.com
  <zoffline ip> secure.zwift.com
  ```

  - Important: don't add `cdn.zwift.com` to `hosts.txt`, Companion needs to download images from the official server

- Turn off "Private DNS" in Android settings
- Run "Virtual Hosts" and select the created `hosts.txt` file
- Optionally, instead of using the "Virtual Hosts" app, you can set `dns.enabled` to `true` in `storage/config.jsonc` and set the "DNS 1" of your phone Wi-Fi connection to the IP address of the PC running zoffline
- Note: If you know what you're doing and have a capable enough router you can adjust your router to alter these DNS records instead of using the "Virtual Hosts" app or changing your phone DNS.

</details>

### Rider accounts and household riding

Every installation uses local rider accounts, whether one person or several people ride. Each desktop launcher startup shows **Who’s riding?**, including when only one rider exists. Select a rider, choose ride options, then **Start Zwift**. **Switch rider** returns to the picker. Progress, workouts, ghosts, activities and integrations remain separate.

On a fresh installation, open the **Create your first rider** link printed by the server. It contains a one-use setup token, also stored in `storage/setup-token.txt` until setup completes. For a remote server use its reachable hostname/IP in the link. The same **Add rider** form is used for the first and later riders: enter a name and optionally a local password. The first rider is the owner/admin; later riders are regular accounts. An official Zwift account is optional. Without importing a profile, Zwift collects physical profile details when you first ride.

Riders with passwords show a password prompt when selected. Riders without passwords can be selected by anyone who can reach the server, including an owner left without a password. In **Settings → Local password**, add protection, or confirm the current password to change/remove it. Changing protection revokes previous sessions, including game refresh tokens. Local passwords are independent of official Zwift and integration credentials.

**Add rider** appears on the picker by default. Disable anonymous registration with `accounts.allow_self_registration: false` in server JSONC and restart; signed-in admins can still add riders. Duplicate display names are allowed; cards show rider numbers. Two devices can ride as different users concurrently. Starting another ride as a rider already active is rejected; switching the launcher does not stop an existing game.

Android uses native credential login, so set a local password for that rider and use the login handle shown in Settings. There is no passwordless native picker.

For a separate server, set `server.advertised_ip` and allow TCP 80, 443, 3025 and UDP 3024 on the local network. This enables private household riding, not access to Zwift’s public multiplayer world.

### Password recovery

Forgotten local passwords and owner access are recovered on the server through the CLI. Stop the server and run:

```sh
zluggish --storage-dir "/path/to/storage" accounts recover --user 1 --admin
```

This prompts privately for a new local password and can restore an explicit admin role. Omit `--admin` for password-only recovery, or use `--remove-password` to make the account open.

### Step 7 [OPTIONAL]: Enable IPv6

To enable support for IPv6 set the environment variable `ZOFFLINE_SERVER_HOST` or use the script `run_ipv6.bat`.

## Migration

### Old storage

These instructions apply to everyone bringing existing storage from the legacy app, including both singleplayer and multiplayer installations. New installations use the first-rider setup described above and do not need migration.

1. Stop the server and back up the entire `storage` directory, including `zwift-offline.db`, settings, activities, and signing/encryption keys.
2. In the server's Python environment, install/update the management CLI:

   ```sh
   pip install -e .
   ```

3. If the old storage has no `config.jsonc`, convert the legacy marker/INI settings first. Preview before applying:

   ```sh
   zluggish --storage-dir "/path/to/storage" config migrate --dry-run
   zluggish --storage-dir "/path/to/storage" config migrate --output "/path/to/storage/config.jsonc"
   ```

4. Upgrade accounts, database and preferences explicitly through the CLI. This step also converts existing JSONC settings, removing retired server, launcher and mail options:

   ```sh
   zluggish --storage-dir "/path/to/storage" accounts migrate
   zluggish --storage-dir "/path/to/storage" config validate
   ```

5. Restart with the same storage directory. If configuration is external, supply `--config /path/to/config.jsonc` to CLI commands and set `ZLUGGISH_CONFIG` for the server. If the CLI is installed separately from the server source, pass `--server-dir /path/to/zluggish` to `accounts migrate`.

Migration runs offline under the server storage lock, backs up changed files/database, and upgrades the database before the server starts. Startup checks compatibility and prints the migration command when needed; it does not upgrade old storage automatically.

An unambiguous solo profile becomes a real open owner account with its existing numeric player ID, `storage/<player_id>/` folder, progress, integrations and anonymous preference overrides. Existing multiplayer users retain their usernames, password hashes and effective admin rights. Everyone uses the rider picker afterward, and remembered sessions need a fresh login. Rider directories are not renamed.

If several legacy profiles or conflicting preferences exist, migration stops rather than guessing. Choose the intended solo folder and preference source explicitly:

```sh
zluggish --storage-dir "/path/to/storage" accounts migrate --solo-player 42 --settings-source anonymous
```

Use `--settings-source rider` to preserve that rider's existing preferences. Unselected folders remain untouched. An imported profile's official ID may differ from its local folder number; use the folder number. Restore missing profile files before converting orphan rider data. For a settings-only conflict on an unused installation, omit `--solo-player`.

Password recovery now uses `accounts recover`, described above. Gmail/SMTP recovery, emailed reset links and `mail.credentials_file` are removed. Migration leaves old mail credential files untouched and unused.

Backups end in `.accounts-<timestamp>.bak`. Rollback requires restoring the matching database/config/settings snapshot while stopped; running an old binary against the new passwordless schema is not rollback. Restoring a snapshot after further rides discards those subsequent writes.

## Extra features

<details><summary>Ghosts</summary>

- Enable this feature by checking "Enable ghosts" in zoffline's launcher (if using Android, access the selected rider’s home page, check "Enable ghosts" and click "Start Zwift" to save the option).
- When you save an activity, the ghost will be saved in `storage/<player_id>/ghosts/<world>/<route>`. Next time you ride the same route, the ghost will be loaded.
- Type `.regroup` in chat to regroup the ghosts.
- Equipment can be customized by creating a file `ghost_profile.txt` inside the `storage` folder. The script `find_equip.py` can populate this asset; set `ghosts.profile_file` to its path in server JSONC.
</details>

<details><summary>Bots</summary>

- Set `bots.enabled` to `true` in server JSONC to load ghosts as bots; they keep riding regardless of your route.
- Set `bots.multiplier` to an integer from 1 to 100 to duplicate bots. Large numbers can affect performance.
- Type `.group` in chat to group the bots, or `.groupall` to include duplicates (if using multiplier). Type `.autogroup` or `.autogroupall` to automatically group whenever you change roads. Type `.stopautogroup` to stop automatic grouping, or `.disperse` to randomize positions.
- Names, nationalities and equipment can be customized by creating a file `bot.txt` inside the `storage` folder. The script `get_pro_names.py` can populate this catalogue; set `bots.riders_file` to its path in server JSONC.
- If you want some random bots, check [this repository](https://github.com/oldnapalm/zoffline-bots).
</details>

<details><summary>RoboPacers</summary>

- RoboPacers are ghosts saved using a power simulator, you can find some in [this repository](https://github.com/oldnapalm/zoffline-bots).
- The ghost must be recorded using update frequency of 1 second (default is 3 seconds).
- The activity must start and finish at the same position and speed, otherwise the bot won't loop smoothly.
- The profile must contain a unique player ID and the route ID, so that when you join the bot you take the same turns at intersections.
- The script `bot_editor.py` can be used to modify `profile.bin` (set name, player ID and route ID) and `route.bin` (cut the exceeding points to make a perfect loop).
- If you want to create a dynamic RoboPacer (increase power on climbs and decrease on descents) you can use [standalone_power.py](https://github.com/oldnapalm/zwift-offline/blob/master/standalone_power.py) (requires 2 ANT sticks, [python-ant](https://github.com/mch/python-ant) and [PowerMeterTx.py](https://github.com/oldnapalm/zwift-offline/blob/master/PowerMeterTx.py)).
</details>

<details><summary>Pelotons (RoboPacer + follower bots)</summary>

- A peloton is one RoboPacer followed by a custom group of bots riding in formation around and behind it, so joining the pacer feels like riding in a real group.
- Followers move up and back inside the group, drift laterally, stretch out on climbs (weaker riders lose some meters and come back on the flat), coast on descents and show realistic power (drafting), cadence and heart rate.
- Quick way: ride next to a RoboPacer and type `.peloton 20` in chat (`.peloton` shows the current size, `.peloton off` removes it). This writes `storage/peloton.jsonc`.
- Or create `storage/peloton.jsonc` manually. `pacer` is the RoboPacer folder name (inside `storage/robopacers`) or its player ID. Every other field is optional:

```json
{
  "pelotons": [
    {
      "pacer": "B - 3.3 WKG - Watopia - Volcano Climb",
      "bots": 25,
      "columns": 0,
      "row_gap": 2.2,
      "lateral_spacing": 65000,
      "beside_pacer": 2,
      "dynamics": 1.0,
      "shuffle_interval": 30,
      "draft": 0.7,
      "climb_stretch": 1.0,
      "max_drop": 40,
      "riders": [
        {
          "first_name": "Tadej",
          "last_name": "Pogacar",
          "country_code": 705,
          "is_male": true,
          "position": "front",
          "strength": 1.3
        },
        {
          "first_name": "Ana",
          "last_name": "Lopez",
          "is_male": false,
          "weight": 55,
          "position": "back",
          "strength": 0.85
        }
      ]
    }
  ]
}
```

- `bots`: total followers (max 200). Riders not listed in `riders` get random names (from the `bots.riders_file` catalogue when configured) and random equipment.
- `columns`: max width of the group (0 = automatic). `row_gap`: meters between rows. `lateral_spacing`: lateral distance between riders in `roadPosition` units (100000 = 1 meter, default 0.65 m). `beside_pacer`: riders alongside the pacer.
- `dynamics`: 0 = rigid formation, 1 = normal, 2 = very lively. `shuffle_interval`: average seconds between position changes. `draft`: fraction of power used by a rider on a wheel. `climb_stretch` and `max_drop`: how much the group stretches on climbs.
- Each rider in `riders` accepts the same fields as `bot.txt` plus `position` (`front`, `middle`, `back` or `any`), `strength` (0.5 - 1.5), `weight` (kg), `height` (cm), `cadence` (rpm) and `max_heart_rate`.
- The file is reloaded automatically when it changes (also with "Reload bots" in the launcher page). Set `"enabled": false` to disable a peloton without deleting it.
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

- To enable all-time leaderboards (override 60 minutes live results and 90 days personal records), set `leaderboards.all_time` to `true` in server JSONC.
- Jerseys are still valid for 60 minutes but will be granted only when a new all-time record is set.
</details>

<details><summary>Entitlements</summary>

- To unlock entitlements (special equipment), set `equipment.unlock_entitlements` to `true` in server JSONC.
- To unlock all equipment, set `equipment.unlock_all` to `true` instead.
</details>

<details><summary>CDN proxy</summary>

- To obtain the official map schedule and update files from Zwift server: set `proxy.mode` to `"enabled"` in server JSONC. This can only work if you are running zoffline on a different machine than the Zwift client.
- By default, zoffline will try to proxy using Google public DNS to resolve Zwift host names, this should work even if zoffline is running on the same machine as the Zwift client. To avoid it, set `proxy.mode` to `"disabled"`. The default mode is `"auto"`.
- If you want to serve update files from zoffline, run the script `get_gameassets.py` to download the game files.
</details>

<details><summary>Discord bridge</summary>

- The Discord bridge is only available if zoffline is running from source.
- Install discord.py: `pip3 install discord.py`
- Create a `discord.cfg` file in the `storage` directory containing
  ```
  [discord]
  token =
  webhook =
  ```
- Reference that credentials file in `integrations.discord.credentials_file`, set `integrations.discord.enabled` to `true`, and configure `channel`, `welcome_message`, `help_message`, and `announce_players` under `integrations.discord` in server JSONC.
</details>

## Community Discord server and Strava club

Please join the community supported [Discord](https://discord.gg/GMdn8F8) server and [Strava](https://www.strava.com/clubs/zoffline) club.

## Dependencies

Docker

-or-

- Python 3 (https://www.python.org/downloads/)
- Flask (https://flask.palletsprojects.com/)
- python-protobuf (https://pypi.org/project/protobuf/)
- pyJWT (https://pyjwt.readthedocs.io/)
- Flask-Login (https://flask-login.readthedocs.io/)
- Flask-SQLAlchemy (https://flask-sqlalchemy.palletsprojects.com/)
- gevent (http://www.gevent.org/)
- pycryptodome (https://pypi.org/project/pycryptodome/)
- dnspython (https://www.dnspython.org/)
- fitdecode (https://pypi.org/project/fitdecode/)
- stravalib (https://stravalib.readthedocs.io/)
- OPTIONAL: garth (https://pypi.org/project/garth/)
- OPTIONAL: discord.py (https://discordpy.readthedocs.io/)

## Note

Future Zwift updates may break zoffline until it's updated. While zoffline is
enabled Zwift updates will not be installed. If a zoffline update broke
something, check the `CHANGELOG` for possible changes that need to be made.

Don't expose zoffline to the internet, it was not designed with that in mind.

<details><summary>If zoffline is out of date from Zwift's official client</summary>
If zoffline is behind in support of the latest Zwift client it can be updated to run using the latest Zwift version.

- Windows: copy `C:\Program Files (x86)\Zwift\Zwift_ver_cur.xml` to zoffline's `cdn/gameassets/Zwift_Updates_Root/` overwriting the existing file.
- macOS: copy `~/Library/Application Support/Zwift/ZwiftMac_ver_cur.xml` to zoffline's `cdn/gameassets/Zwift_Updates_Root/` overwriting the existing file.
- Linux: run [this script](https://gist.github.com/zoffline/b874e93e24439f0f4fbd7b55f3876fd2) from within the zwift-offline repository.

Note: there is no guarantee that an untested Zwift update will work with zoffline. However, historically, Zwift updates rarely break zoffline.

Alternatively, [this script](https://gist.github.com/oldnapalm/556c58448a6ee09438b39e1c1c9ce3d0) can be used to downgrade Zwift to the version supported by zoffline.

</details>

<details><summary>Update failed during patching</summary>

If you get this error even though zoffline is up to date, rename the file `Zwift_ver_cur.<version>.xml` in Zwift directory to `Zwift_ver_cur.xml` and edit the file `Zwift_ver_cur_filename.txt` accordingly.

</details>

## Legal notice

Zluggish is an independent, community-developed project. It is **not affiliated with, endorsed by, sponsored by, or officially supported by Zwift, Inc.** Zwift is a trademark of Zwift, Inc. Other product and company names belong to their respective owners; references to them do not imply affiliation or endorsement.

Zluggish is licensed under the **GNU Affero General Public License, version 3 (AGPL-3.0)**. See [LICENSE](LICENSE) for the full terms, including the warranty disclaimer. Third-party components retain their respective licenses and copyright notices. This license does not grant rights to Zwift's proprietary client, game assets, or trademarks.

This project is based on [zwift-offline](https://github.com/zoffline/zwift-offline) and [fatsbrown's fork of zwift-offline](https://github.com/fatsbrown/zwift-offline). Credit for that foundation belongs to their authors and contributors.
