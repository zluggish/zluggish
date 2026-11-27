---
sidebar_position: 1
description: Change a password, or recover access when nobody can sign in.
---

# Password recovery

## Change a password in the web app

- To change your own password, select **Change password** on the **Profile** page.
- To set the password of a different user, an administrator goes to **Manage → Users**.
- If an administrator gave you a one-time password, sign in to the web app with it and choose your own password. Zwift accepts only the password that you choose.

## Recover access with the CLI

Use this procedure if nobody can sign in.

1. Stop the server.
2. Put the new password in a private file.
3. From the repository root, run:

   ```sh
   pnpm --dir server cli --storage-dir /path/to/storage accounts recover --user 1 --password-file /private/path/new-password.txt --admin
   ```

4. Delete the password file.
5. Start the server.

With Docker Compose, run the same command through the container. See [Run with Docker Compose](../reference/cli/index.md#run-with-docker-compose).

- `--admin` enables the user and gives the administrator role. Without `--admin`, the role and the enabled state do not change.
- A user cannot be without a password.
- The CLI cancels the existing sessions.
- The CLI does not ask for a password. It reads the password only from the file.

Gmail and SMTP reset links are not supported.

For all options, see [Recover a local account](../reference/cli/accounts.md#recover-a-local-account).
