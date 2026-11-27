---
sidebar_position: 1
description: Use the Zluggish web app to manage rides, accounts and the server.
---

# Web app

The Zluggish web app is the portal for managing the game, including installing the patched client apps and the companion.

On a local network, open the web app at `http://<server-address>:8080` using the default web app port. Setup commands, one-time passwords and server logs can be copied over HTTP. If the browser blocks automatic copying, select and copy the text from the field that appears.

![The Zluggish web app showing activities, a route map, elevation profile and ride statistics](../../media/screenshots/webapp-activities.png)

## Rider pages

| Page         | What you can do                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Activities   | Browse rides by month. View the route, elevation and ride statistics. Download FIT files and images.                           |
| Profile      | Edit your profile and avatar, change your password, and use **Import / Export** to transfer data.                              |
| Climbs       | See the climb portals you have ridden, with categories, elevation profiles and best times.                                     |
| Integrations | Set up [activity uploads and workout imports](integrations/index.md).                                                          |
| Settings     | Toggle ghosts and regenerate power curves.                                                                                     |
| Apps         | Set up Zwift for Windows, macOS, Linux or Android, or [install Companion on Android](../install/clients/companion-android.md). |

## Administrator pages

Open **Manage** in the sidebar.

- **Users** lets you create, disable or delete accounts, set passwords, change roles and end sessions.
- **Users → Create user** gives a new user a one-time password by default. Give the user this password. The password shows only once, on the new user's page. At first sign-in to the web app, the user chooses their own password. Until then, the user cannot ride Zwift. To choose the password yourself, select **Set a password**.
- **Android apps** lets you publish [Zwift](../install/clients/android.md#publish-zwift-for-android) and [Companion](../install/clients/companion-android.md#publish-companion) builds for your server.
- **Server** lets you rotate the [certificate](../install/certificate.md), [start a backup](../maintenance/backup-and-restore.md), read logs and manage bots, events and world settings.

## Turn off the web app

If you want, the webapp can be disabled entirely. Set `network.web.enabled` to `false` in `zluggish.config.ts` and restart the server. You can still ride Zwift via the game launcher.
