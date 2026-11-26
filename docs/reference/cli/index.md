---
sidebar_position: 1
title: Admin CLI
description: Run the Zluggish admin CLI natively or with Docker Compose.
---

# Admin CLI

The CLI manages the configuration, user settings, legacy migrations, account recovery and storage. It works directly on the configuration files and the storage. It does not connect to a running server, and it does not start one.

Run the commands from the **repository root**. Replace the sample paths and the rider ID `1` with your values.

:::warning[Stop the server first]

Stop all servers that use the storage before you run these commands:

- `accounts migrate` and `accounts recover`
- `config migrate`, except with `--dry-run`
- `settings set` and `settings reset`, except with `--dry-run`
- All `storage` and `uploads` commands

These commands lock the storage.

:::

## Run with Docker Compose

The server image has the `zluggish` command and all its dependencies. You do not need Node.js or pnpm on the host.

Run the CLI through the [Compose service of the server](../../install/server.md), from the directory with `docker-compose.yml`. It uses the same storage and container configuration as the server:

```sh
docker compose run --rm --no-deps zluggish zluggish --help
docker compose run --rm --no-deps zluggish zluggish config validate
```

For an offline change, stop the server, run the command, then start the server again:

```sh
docker compose stop zluggish
docker compose run --rm --no-deps zluggish zluggish accounts migrate
docker compose up -d zluggish
```

From a source checkout, add `-f docker/docker-compose.yml` after `docker compose`, and run from the repository root.

- `docker compose run` does not publish the service ports.
- All paths that you give to the CLI must be container paths. Mount external configuration or password files into the container.
- The default container config uses the mounted storage at `/usr/src/app/zluggish/storage`.
- The CLI uses an existing config in that storage, like the server. Before the first start, it uses the default config of the image.
- For a config migration, select an output path on a writable mount.

You can also run the image directly on a storage directory:

```sh
docker run --rm -v /absolute/path/to/storage:/usr/src/app/zluggish/storage ghcr.io/zluggish/zluggish:latest zluggish config validate
```

The Compose file uses the published image. To build an image from source, see [Container smoke tests](../../development.md#container-smoke-tests).

:::warning

Config files are trusted code. The CLI has full administrator access to the mounted storage.

:::

## Run from source

Follow [Run locally](../../development.md#run-locally) through `mise run install`. Build and run the CLI from the repository root.

```sh
mise run build
mise exec -- node server/dist/src/cli/bin.js --help
mise exec -- node server/dist/src/cli/bin.js --config ./examples/reference/zluggish.config.ts config validate
```

To run the TypeScript entry point before building, use `mise run cli -- --help`. That task runs from `server/`, so use absolute paths or paths relative to that directory for its arguments.

## Common options

The examples use `node server/dist/src/cli/bin.js`. You can also run them with Docker Compose. Use container paths for arguments when you do.

| Option              | Meaning                                                                        |
| ------------------- | ------------------------------------------------------------------------------ |
| `--help`, `-h`      | Show the CLI help. The CLI also shows the help when you give no arguments.     |
| `--config PATH`     | Select the operator config. The file name must be `zluggish.config.ts`.        |
| `--storage-dir DIR` | Select the storage. A relative path starts from the current working directory. |

## How the CLI selects the config and the storage

The CLI selects the config in this order:

1. `--config`
2. `ZLUGGISH_CONFIG`
3. An existing config in the container storage
4. `server/zluggish.config.ts` in the checkout

For commands that load a config, the CLI selects the storage in this order:

1. `--storage-dir`
2. `ZLUGGISH_STORAGE_DIR`
3. The `storageDir` of the config

Paths in the config are relative to the config file.

`config migrate` selects the storage from `--storage-dir`, `ZLUGGISH_STORAGE_DIR` or the `storage/` directory of the repository. It does not load the destination config.

Account commands use the explicit storage options first. Then they use the storage of an existing selected config. Then they use the `storage/` directory of the repository.

## Exit codes

Commands return `0` when they succeed and `2` when they fail. Node.js can also show a warning that SQLite is experimental.

## Commands

- [Configuration commands](configuration.md)
- [Rider settings commands](settings.md)
- [Account commands](accounts.md)
- [Storage and upload commands](storage.md)
