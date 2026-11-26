---
sidebar_position: 5
description: Make Zwift use the official service again.
---

# Uninstall

To use the official Zwift service again:

1. Remove the Zluggish line from the `hosts` file, or make it a comment.
2. Close Zwift fully. On Windows, right-click the Zwift icon in the system tray and select exit.
3. Start Zwift.

To remove the server certificate too:

- On Windows, open **Manage computer certificates**. Under **Trusted Root Certification Authorities → Certificates**, delete **\*.zwift.com** with **Zluggish** in the **Friendly Name**. In `data\cacert.pem` in the Zwift folder, delete the lines from `# BEGIN Zluggish` to `# END Zluggish`.
- On macOS, open Keychain Access. In the **System** keychain, delete **\*.zwift.com** with **Zluggish** in its organizational unit. In `~/Library/Application Support/Zwift/data/cacert.pem`, delete the certificate you appended.
- On Linux, delete `zluggish-zwift-*.crt` from the trust store directory, such as `/usr/local/share/ca-certificates`, and run `update-ca-certificates` or `update-ca-trust`. In `data/cacert.pem` of Zwift, delete the lines from `# BEGIN Zluggish` to `# END Zluggish`.

On Android, undo the DNS redirect you set up. This may mean turning off Virtual Hosts, restoring your Wi-Fi DNS settings, removing a router override or disconnecting the Cloudflare One Client.

To remove the server, stop the container with `docker compose down` in the directory with `docker-compose.yml`. The `storage` directory stays. Delete it only if you do not need your data.
