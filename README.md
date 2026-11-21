<img src="https://raw.githubusercontent.com/zluggish/zluggish/main/media/zluggish.svg" alt="An orange snail with a Z" height="200">

# Zluggish

Zluggish is a self-hosted, open-source server for [Zwift](https://zwift.com), written in TypeScript. Run it on your own network and ride any world, with your own ghosts, pacers and pelotons, and a web app for the whole household.

**📖 Documentation: [docs.zluggish.com](https://docs.zluggish.com/)**

<img src="media/screenshots/webapp-activities.png" alt="The Zluggish web app showing a month of rides, with the route map, elevation profile and power and heart rate stats of the selected ride">

## Features

- **Offline play**: ride with no connection to the Zwift servers.
- **Any world, any day**: pick the map yourself instead of following the official schedule.
- **[Ghosts](https://docs.zluggish.com/usage/features/ghosts/)**: race your previous efforts on the same route, and regroup them from chat.
- **[RoboPacers](https://docs.zluggish.com/usage/features/robopacers/) and [pelotons](https://docs.zluggish.com/usage/features/pelotons/)**: build pacers from recorded rides and surround them with follower bots that ride in formation, stretch out on climbs and coast on descents.
- **[Solo blob](https://docs.zluggish.com/usage/features/solo-blob/)**: summon a rotating group of bots around you with `.blob 20`, no pacer needed.
- **[Bookmarks](https://docs.zluggish.com/usage/features/bookmarks/)**: save named positions during a ride, start new sessions from them or teleport back.
- **[Intervals.icu planned workouts](https://docs.zluggish.com/usage/integrations/intervals-icu/)**: today's scheduled workouts appear in the game, and finished rides sync back. TrainingPeaks `.zwo` exports work too.
- **[Activity uploads](https://docs.zluggish.com/usage/sharing-activities/)** to Strava, Garmin Connect, Intervals.icu, Runalyze and your official Zwift account.
- **[Chat bridges](https://docs.zluggish.com/usage/chat-bridges/discord/)**: connect in-game chat to Discord or Matrix.
- **[All-time leaderboards](https://docs.zluggish.com/usage/features/leaderboards/)** and **[equipment control](https://docs.zluggish.com/usage/features/entitlements/)**: keep records on your own server and unlock bikes and upgrades without the grind.
- **Your data stays yours**: profiles, activities and recordings live in local storage that you can back up and inspect.

> [!NOTE]
> Zluggish is offline only. It does not connect to the public Zwift world, so you cannot join official races, group rides, club events or global leaderboards, and local progress is separate from your Zwift account. You can still ride with family and friends on the same Zluggish server.

## What's new compared to zwift-offline

Zluggish is a rewrite of [zwift-offline](https://github.com/zoffline/zwift-offline) and [fatsbrown's fork](https://github.com/fatsbrown/zwift-offline). It keeps their features and adds:

- **A web app for the household**: riders manage their profile, activities, imports, exports, integrations and settings in the browser. Administrators manage users and the server without editing files or using a CLI.
- **Activity browser**: rides by month with route map, elevation profile, power and heart rate stats, power curves, and FIT and image downloads.
- **Climbs page**: every climb portal you have ridden, with ride count, best time and a link to its Strava segment. The launcher marks the climbs you have already done.
- **A new game launcher**: each rider picks themselves on a _Who's riding?_ screen, then chooses a map and climb before starting Zwift.
- **A certificate of its own**: each server generates its own key, instead of the shared zwift-offline certificate whose private key is public. Riders set up Windows, macOS and Linux computers with a script from the web app.
- **Guided first-time setup** with a one-time setup key, and proper accounts with administrator roles.
- **Automatic migration**: point Zluggish at your zwift-offline `storage` folder and it converts your storage on first start.
- **One SQLite database** instead of scattered files, with durable activity saves and upload retries from the web app.
- **A typed config file** (`zluggish.config.ts`) and an admin CLI for accounts, settings and storage.
- **Docker Compose deployment**: one file, one command, no Python runtime.
- **Matrix chat bridge** (experimental), next to the existing Discord bridge.
- **Structured logging** that tracks logins, rides and uploads without logging credentials or personal data.

<table>
  <tr>
    <td><img src="media/screenshots/launcher-riders.png" alt="The launcher's Who's riding? screen listing five riders with their avatars"></td>
    <td><img src="media/screenshots/launcher-dashboard.png" alt="The launcher after signing in, with Map and Climb choices and a Start Zwift button"></td>
  </tr>
</table>

## Get started

Zluggish needs some technical know-how to set up. You need a server that runs Docker (Linux, Windows or macOS; performance needs are very low) and a Zwift client on Windows, macOS or Android. iOS is not supported.

```sh
mkdir zluggish && cd zluggish
curl -LO https://raw.githubusercontent.com/zluggish/zluggish/main/docker/docker-compose.yml
docker compose up -d
```

Then follow the documentation:

1. [Requirements](https://docs.zluggish.com/install/requirements/)
2. [Install the server](https://docs.zluggish.com/install/server/) and do the [first-time setup](https://docs.zluggish.com/install/server/#first-time-setup)
3. Set up the client on [Windows](https://docs.zluggish.com/install/clients/windows/), [macOS](https://docs.zluggish.com/install/clients/macos/) or [Android](https://docs.zluggish.com/install/clients/android/)

Coming from zwift-offline? Read [Migrate from zwift-offline](https://docs.zluggish.com/maintenance/migrating/) first, and back up your storage folder.

Game access tokens expire after six hours; refresh credentials expire after 90 days. Only refresh credentials can renew game access. Updating from older versions invalidates existing game tokens, so sign in again through the launcher.

## Documentation

| Topic                                                                           | Covers                                                            |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [Install](https://docs.zluggish.com/install/requirements/)                      | Server, clients, Zwift Companion app, IPv6                        |
| [Use](https://docs.zluggish.com/usage/web-app/)                                 | Web app, in-game features, integrations, chat bridges             |
| [Maintain](https://docs.zluggish.com/maintenance/update/)                       | Updates, backup and restore, migration, profile import, uninstall |
| [Reference](https://docs.zluggish.com/reference/configuration/)                 | Configuration, admin CLI, ports                                   |
| [Troubleshooting](https://docs.zluggish.com/troubleshooting/password-recovery/) | Password recovery, client updates, logging                        |

Future Zwift updates can break compatibility. See [client updates](https://docs.zluggish.com/troubleshooting/client-updates/) and the [CHANGELOG](CHANGELOG) before you update. Keep Zluggish on a trusted local network; it is not designed for exposure to the internet.

## Community

Join the community [Discord server](https://discord.gg/GMdn8F8) and [Strava club](https://www.strava.com/clubs/zoffline).

## Development

Install [mise](https://mise.jdx.dev/getting-started.html), then run:

```sh
cd server
mise install
mise run install
mise run check
```

See the [development guide](https://docs.zluggish.com/development/) and read the [contributing guidelines](CONTRIBUTING.md) before you open a pull request.

## Legal notice

Zluggish is an independent, community-developed project. It is **not affiliated with, endorsed by, sponsored by, or officially supported by Zwift, Inc.** Zwift is a trademark of Zwift, Inc. Other product and company names belong to their respective owners; references to them do not imply affiliation or endorsement.

Zluggish is licensed under the **GNU Affero General Public License, version 3 (AGPL-3.0)**. See [LICENSE](LICENSE) for the full terms, including the warranty disclaimer. Third-party components retain their respective licenses and copyright notices. This license does not grant rights to Zwift's proprietary client, game assets, or trademarks.

This project is based on [zwift-offline](https://github.com/zoffline/zwift-offline) and [fatsbrown's fork of zwift-offline](https://github.com/fatsbrown/zwift-offline). Credit for that foundation belongs to their authors and contributors.
