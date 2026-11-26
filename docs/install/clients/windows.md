---
sidebar_position: 1
description: Connect Zwift for Windows to Zluggish.
---

# Windows

Use the setup script below by default. For other ways to point Zwift at your server, see [DNS settings](dns-settings.md).

Download the setup script from the specific Zluggish server you want to connect to. Each server has its own certificate; a script from another server will not install the certificate you need. For manual setup, download the certificate files from that same server.

1. Install Zwift. Open it once to finish any updates, then exit it from the system tray before signing in.
2. In the [web app](../../usage/web-app.md), open **Apps → Zwift → Windows**. Use **Other systems** if Windows is hidden.
3. Select **Download setup script**.
4. Open the downloaded `.bat` file and allow it to run as an administrator. If SmartScreen blocks it, select **More info → Run anyway**.
5. Wait for **Done**, then open Zwift and sign in through the Zluggish launcher.

The script adds the Zluggish certificate in the Local Computer root store and adds it to `data\cacert.pem` in the Zwift folder. It also updates `C:\Windows\System32\drivers\etc\hosts` unless you turn off **Patch hosts file** under **Advanced settings**. Before editing a file for the first time, the script saves a copy with the `.zluggish-backup` suffix.

## Manual setup

1. Open **Apps → Zwift → Manual setup** and download the `.cer` and `.crt` files.
2. Open an administrator Command Prompt. Import the certificate using the filename you downloaded.

   ```bat
   certutil.exe -addstore Root zluggish-zwift-XXXXXXXX.cer
   ```

3. Append the contents of the `.crt` file to `data\cacert.pem` in the Zwift installation directory.
4. With administrator rights, add the hosts line from **Manual setup** to `C:\Windows\System32\drivers\etc\hosts`. Use the server's IP address, or `127.0.0.1` if Zwift and Zluggish run on the same computer.

Run setup again when the [server certificate changes](../certificate.md) or if a [Zwift update](../../troubleshooting/client-updates.md) overwrites the client files.

## Uninstall

To switch back to the official service and remove the Zluggish certificate, follow the [uninstall instructions](../../maintenance/uninstall.md).
