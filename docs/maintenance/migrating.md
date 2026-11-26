---
sidebar_position: 2
description: Move from zwift-offline to Zluggish.
---

# Migrate from zwift-offline

Zluggish is a rework of the legacy zwift-offline app. The main differences are:

- The code is written in TypeScript.
- A Svelte web app manages users, server settings, activities and integrations.
- The storage and the settings management are better.

Zluggish tries to import and convert your storage automatically. Before a legacy conversion, it saves a gzip-compressed snapshot in `storage/backups/`. If the snapshot fails, the migration stops before changing the legacy data. Keep the earliest migration snapshot if you plan to roll back to zwift-offline.

:::danger

Back up your zwift-offline folder before you start.

:::

## Migrate

1. Back up the complete zwift-offline folder.
2. Stop zwift-offline.
3. Copy the zwift-offline `storage` directory to the `storage` directory of Zluggish.
4. [Install the Zluggish server](../install/server.md) and start it. The server converts the storage when it starts.
5. Follow [first-time setup](../install/server.md#first-time-setup). Select **Use an existing user** and select a migrated user that has a password. That user becomes the administrator.
6. Set the passwords of the other users again.
7. Set up each Zwift device again from **Apps**. With the default TLS settings, Zluggish generates a [new server certificate](../install/certificate.md) the first time it starts.

Migrated users do not have passwords. Before a user without a password can become the administrator, set a password with [account recovery](../reference/cli/accounts.md#recover-a-local-account).

## Migrate the configuration and the accounts with the CLI

You can also migrate offline with the CLI. Stop the server first.

- To migrate the legacy settings, use [`config migrate`](../reference/cli/configuration.md).
- To migrate the legacy accounts, use [`accounts migrate`](../reference/cli/accounts.md#migrate-legacy-accounts).

If a migration stops before it is complete, run the same command with the same destination again. Keep `.config-migration.json`, and do not edit the config that the migration has written.

## Roll back

1. Stop Zluggish.
2. Restore the zwift-offline folder from your backup. To use the Zluggish pre-migration snapshot, extract the earliest `.tar.gz` archive into an empty zwift-offline storage directory.
3. Start zwift-offline.
