---
sidebar_position: 4
description: Migrate legacy accounts and recover a local account.
---

# Account commands

Account commands run offline on the selected storage. If `--storage-dir` points to the storage directory, they do not need a config file.

## Migrate legacy accounts

1. Back up the storage.
2. Stop the server.
3. Run the migration:

   ```sh
   node server/dist/src/cli/bin.js --storage-dir ./storage accounts migrate
   ```

If the CLI cannot find the solo owner, select the player with `--solo-player ID`:

```sh
node server/dist/src/cli/bin.js --storage-dir ./storage accounts migrate --solo-player 42
```

The migration makes a database backup with an `.accounts-<timestamp>.bak` suffix. It keeps the local profile IDs and the supported password hashes. See also [Migrate from zwift-offline](../../maintenance/migrating.md).

## Recover a local account

Use this command when a user cannot sign in, or when nobody has administrator access.

1. Stop the server.
2. Put the new password in a private UTF-8 file.
3. Run the recovery:

   ```sh
   node server/dist/src/cli/bin.js --storage-dir ./storage accounts recover --user 1 --password-file /private/path/new-password.txt
   ```

   On Windows, use a Windows path for the file:

   ```powershell
   node .\server\dist\src\cli\bin.js --storage-dir .\storage accounts recover --user 1 --password-file 'C:\Private\new-password.txt'
   ```

4. Delete the password file.
5. Start the server.

To give the user administrator access, add `--admin`. This option also enables the user. Without `--admin`, the command changes only the password.

The CLI reads the password from the file and removes one newline at the end. It does not ask for a password.

All users must have a password, so recovery always sets a new password. Recovery also cancels the existing tokens and all remembered launcher logins.

Riders that were migrated from legacy password hashes start without a password. Recover each of these riders before they can sign in.
