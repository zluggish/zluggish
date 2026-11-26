---
sidebar_position: 2
description: Install the Zluggish server with Docker Compose.
---

# Install the server

If you have an existing install of the legacy zwift-offline app, read the [migration guide](../maintenance/migrating.md) first.

1. Create a directory for Zluggish and a `docker/` subdirectory inside it.
2. Save the [Compose file](https://raw.githubusercontent.com/zluggish/zluggish/main/docker/docker-compose.yml) as `docker/docker-compose.yml`.
3. Start the server and read its logs from the `docker/` directory.

   ```sh
   docker compose up -d
   docker compose logs zluggish
   ```

The server is ready when the logs show `Zluggish is ready`. Compose mounts `../storage` for the configuration, database and other server data. With the directory layout above, `storage/` and `docker/` are siblings.

## First-time setup

1. Find **Setup key** in the logs. It is valid until you complete setup or stop the server. Keep it private.
2. On the server computer, open [http://localhost:8080/setup](http://localhost:8080/setup). To use a browser on another device, see [web app access](../usage/web-app.md).
3. Enter the key and select **Check key**.
4. Enter your name and login name. Enter and confirm your password, then select **Complete setup** to create the first administrator.

## Connect a client

If Zwift runs on another device, set `server.advertisedIp` to the server's LAN IP in `storage/zluggish.config.ts` and restart Zluggish. See [Configuration](../reference/configuration.md) and [Ports](../reference/ports.md).

Set up Zwift on [Windows](clients/windows.md), [macOS](clients/macos.md), [Linux](clients/linux.md) or [Android](clients/android.md).

To work on Zluggish from source, see the [development guide](../development.md).
