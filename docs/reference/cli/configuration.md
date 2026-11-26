---
sidebar_position: 2
description: Make, check, show and migrate the configuration file.
---

# Configuration commands

| Command                                             | Result                                                                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config init`                                       | Copy the default typed config to the selected path. The command does not overwrite an existing file.                                                |
| `config validate`                                   | Run the config and check its values and the resource files that it uses.                                                                            |
| `config show`                                       | Show a JSON summary: config path, storage, network, accounts, and bot settings. Sensitive sections are not included. This is not a complete export. |
| `config typecheck`                                  | Typecheck the selected config. The server image includes TypeScript. The command shows diagnostic codes and returns `2` for errors.                 |
| `config migrate --dry-run`                          | Show the result of a migration of legacy marker, text, INI and JSON settings. The command writes nothing.                                           |
| `config migrate [--output PATH] [--solo-player ID]` | Migrate legacy settings into a typed config and SQLite overrides. The original files stay. The default output is the selected config path.          |

```sh
node server/dist/src/cli/bin.js config init
node server/dist/src/cli/bin.js config validate
node server/dist/src/cli/bin.js config show
node server/dist/src/cli/bin.js config typecheck
node server/dist/src/cli/bin.js --storage-dir ./storage config migrate --dry-run
node server/dist/src/cli/bin.js --storage-dir ./storage config migrate --output ./storage/zluggish.config.ts --solo-player 42
```

## New setup or migration

- For a new setup, use `config init`.
- For legacy storage, use `config migrate`. The destination must be a new file with the name `zluggish.config.ts`. Do not make it with `config init` first.

`--solo-player` selects the ID of the local legacy profile folder, when you must select the solo owner. This ID can be different from an imported official Zwift ID.

`config migrate` does not migrate accounts. Use [`accounts migrate`](accounts.md#migrate-legacy-accounts) for the accounts.

## Before and during a migration

:::danger

Back up the complete storage directory before a migration.

:::

- If the migration stops, run the same command with the same destination again.
- Keep `.config-migration.json`.
- Do not edit a config that the migration has not completed.

See also [Migrate from zwift-offline](../../maintenance/migrating.md).
