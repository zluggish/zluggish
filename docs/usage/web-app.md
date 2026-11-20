---
sidebar_position: 1
description: The Zluggish web app for users and administrators.
---

# Web app

Users and administrators use the web app to work with Zluggish. The default address is `http://<server-ip>:8080`.

:::warning

Use the web app only on a network that you trust. Without HTTPS, other devices on the network can read the passwords that users type.

:::

To make the first administrator, do the [first-time setup](../install/server.md#first-time-setup).

## User pages

All users have these pages in the menu:

| Page         | Use                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------- |
| Profile      | Show and edit your profile and avatar. Change your password.                                    |
| Activities   | Show saved activities by month, with route, elevation and stats. Download FIT files and images. |
| Import       | Import profile data from local files or from your official Zwift account.                       |
| Export       | Download your user data.                                                                        |
| Integrations | Connect Strava, Garmin, Intervals.icu and TrainingPeaks. Follow the status of activity uploads. |
| Settings     | Turn ghosts on or off. Calculate the power curves again.                                        |
| Climbs       | Show the climb portals you rode, with category, elevation profile and best time.                |
| Install      | Download the setup script that makes a Windows, macOS or Linux computer trust this server.      |

![The Profile page with avatar, name, email and birthday](../../media/screenshots/webapp-profile.png)

![The Settings page with the Ride with ghosts option and Regenerate power curves](../../media/screenshots/webapp-settings.png)

## Administrator pages

Administrators also have **Users** and **Server** under **Manage**:

- **Users**: make, enable, disable and delete users. Give or remove the administrator role. Set passwords, end sessions and edit the settings of a user.
- **Server**: see and rotate the [server certificate](../install/certificate.md). Make a backup. Reload or control bots, and edit stored world settings, such as blob and peloton overrides. Edit and delete events. Show the effective configuration.

Changes to `zluggish.config.ts` need a server restart.

![The Users page listing five users, with an administrator, a disabled user and a user who is riding now](../../media/screenshots/webapp-users.png)

## Use a reverse proxy

1. Set `network.web.publicUrl` to the address that users open, for example `https://zluggish.example.com`.
2. Start the server again.

The web app then accepts requests only from that address. With an `https` address, the sign-in cookies get the `Secure` flag.

## Turn off the web app

The first-time setup and new users need the web app. After the setup, an administrator can turn it off.

1. Set `network.web.enabled` to `false` in `zluggish.config.ts`.
2. Start the server again.

When the web app is off:

- Nobody can make or manage users, show activities, or change settings and integrations.
- Rides continue to work. Users with a password can sign in through the game launcher.
- The server continues to save and upload activities.

To turn it on again, set `network.web.enabled` to `true` and start the server again.
