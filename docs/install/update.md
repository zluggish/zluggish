---
sidebar_position: 8
description: Update the Zluggish server and keep the Zwift client compatible.
---

# Update

## Update the server

1. Read the [release notes](https://github.com/zluggish/zluggish/releases) and the [CHANGELOG](https://github.com/zluggish/zluggish/blob/main/CHANGELOG). Some changes need an action from the server admin.
2. Back up the storage. See [Back up and restore](../maintenance/backup-and-restore.md).
3. If the old container has backups in a Docker volume, [copy them to the host](../maintenance/backup-and-restore.md#recover-backups-from-an-older-docker-container) before recreating it.
4. In the directory with `docker-compose.yml`, get the new image and start it:

   ```sh
   docker compose pull && docker compose up -d
   ```

With the default `latest` tag, this installs the newest release. If `docker-compose.yml` names a version such as
`0.0.1`, change it to the new version first. See [Choose an image tag](server.md#choose-an-image-tag).

## Update the Zwift client

Zwift updates can break compatibility with Zluggish. On Windows and macOS, **Manage → Server → Zwift client updates**
holds new update downloads through Zluggish by default. When you choose **Allow updates**, redirected desktop launchers
can request the updates Zwift currently offers. The setting applies to all redirected desktop clients and persists
across server restarts. Choose **Hold updates** when you are done. Allowing updates requires the CDN proxy.

The hold applies to requests that reach Zluggish. An already downloaded update can still be installed. A Zluggish
release can change the bundled version that the launcher sees even while downloads are on hold. Android app updates
are managed through Google Play.

If you need to update using the official service:

1. Check that Zluggish supports the target Zwift version.
2. Switch the client back to the official service. See [Uninstall](../maintenance/uninstall.md).
3. Update Zwift.
4. Set up the client redirection again.

If Zluggish is older than the Zwift client, see [Zwift client updates](../troubleshooting/client-updates.md).
