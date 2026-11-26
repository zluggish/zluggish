---
sidebar_position: 3
description: Fix problems when Zwift is newer than Zluggish, or when an update fails.
---

# Zwift client updates

Zwift updates can break compatibility with Zluggish. Before you update Zwift, see [Update the Zwift client](../install/update.md#update-the-zwift-client).

## Zluggish is older than the Zwift client

If you change the advertised client version, a newer client can start. This does not make the protocol compatible.

Copy the version file of the client to `assets/cdn/gameassets/Zwift_Updates_Root/` in Zluggish. Overwrite the existing file.

| Platform             | Version file                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Windows              | `C:\Program Files (x86)\Zwift\Zwift_ver_cur.xml`                                                                 |
| macOS                | `~/Library/Application Support/Zwift/ZwiftMac_ver_cur.xml`                                                       |
| Linux or server only | Get the version XML from the client installation. Older upstream helper scripts expect the old directory layout. |

After you change the bundled assets, build the Docker image again. Make sure that the client is compatible before you change an installation that works.

:::warning

An untested Zwift update can fail to work with Zluggish.

:::

You can also use [this script](https://gist.github.com/oldnapalm/556c58448a6ee09438b39e1c1c9ce3d0) to install the Zwift version that your server supports.

## The update fails during patching

If this error occurs and Zluggish is up to date:

1. In the Zwift directory, rename `Zwift_ver_cur.<version>.xml` to `Zwift_ver_cur.xml`.
2. Edit `Zwift_ver_cur_filename.txt` so that it contains the new file name.

## Sign in again after an update

Updates from versions with older game credentials can require a new sign-in in the launcher. Game access tokens expire after six hours. Refresh credentials expire after 90 days.

If a client resets its connection or sequence counters under an existing relay key, start a fresh game login. This gives the client a new key. After restoring an older backup, start a fresh login before riding.
