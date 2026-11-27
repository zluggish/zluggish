---
sidebar_position: 1
description: Connect Zwift for Windows to Zluggish.
---

# Windows

1. Install Zwift normally. Open it once to finish any updates, then exit it from the system tray before signing in.
2. In the [Zluggish web app](../../usage/web-app.md), open **Apps → Zwift → Windows**. Use **Other systems** if Windows is hidden.
3. Select **Download setup script**. Each server has its own certificate, so use the script from the server you want to connect to.
4. Open the downloaded `.bat` file and allow it to run as an administrator. If SmartScreen blocks it, select **More info → Run anyway**.
5. Wait for **Done**, then open Zwift and sign in through the Zluggish launcher.

The script adds the Zluggish certificate to the Local Computer root store and to `data\cacert.pem` in the Zwift folder. By default, the script also adds the Zwift host names to `C:\Windows\System32\drivers\etc\hosts`, pointing at the Zluggish IP address.

To keep the script away from your DNS settings, turn off **Patch hosts file** under **Advanced settings** before you download it. Then set up the redirect yourself with the [DNS settings page](dns-settings.md).

## Updating

If Zwift updates, it may lose its connection to Zluggish. In that case, download the setup script from your server and run it again. Do the same when the [server certificate changes](../certificate.md).

## Manual setup

To patch Zwift by hand:

1. Open **Apps → Zwift → Manual setup** in the web app and download the `.cer` and `.crt` files.
2. Open an administrator Command Prompt. Import the certificate using the filename you downloaded.

   ```bat
   certutil.exe -addstore Root zluggish-zwift-XXXXXXXX.cer
   ```

3. Append the contents of the `.crt` file to `data\cacert.pem` in the Zwift installation directory.
4. With administrator rights, add the hosts line from **Manual setup** to `C:\Windows\System32\drivers\etc\hosts`. Use the server's IP address, or `127.0.0.1` if Zwift and Zluggish run on the same computer.

## Uninstall

To remove the Zluggish patches, follow the [uninstall instructions](../../maintenance/uninstall.md).
