---
sidebar_position: 1
description: Connect Zwift for Windows to Zluggish.
---

# Windows

Zluggish supports running the game client on Windows.

1. Install Zwift normally. Open it once to finish any updates, then exit it from the system tray before signing in.
2. In the [Zluggish web app](../../usage/web-app.md), open **Apps → Zwift → Windows**. Use **Other systems** if Windows is hidden.
3. Select **Download setup script**. Note that you need the setup script from a specific Zluggish server since each server has a unique certificate.
4. Open the downloaded `.bat` file and allow it to run as an administrator. If SmartScreen blocks it, select **More info → Run anyway**.
5. Wait for **Done**, then open Zwift and sign in through the Zluggish launcher.

The script adds the Zluggish certificate in the Local Computer root store and adds it to `data\cacert.pem` in the Zwift folder. By default, the script also updates DNS lookup settings in `C:\Windows\System32\drivers\etc\hosts` with the Zluggish ip adress.

If you don't want the script to change DNS settings, turn off **Patch hosts file** under **Advanced settings** before downloading the script. You can then manually follow the instructions on the [DNS settings page.](dns-settings.md).

## Updating

If Zwift updates, there is a risk that it loses its connection to Zluggish. In that case, download the setup script and rerun.

## Manual setup

If you want to patch Zwift manually, perform these steps:

1. Open **Apps → Zwift → Manual setup** in the webapp and download the `.cer` and `.crt` files.
2. Open an administrator Command Prompt. Import the certificate using the filename you downloaded.

   ```bat
   certutil.exe -addstore Root zluggish-zwift-XXXXXXXX.cer
   ```

3. Append the contents of the `.crt` file to `data\cacert.pem` in the Zwift installation directory.
4. With administrator rights, add the hosts line from **Manual setup** to `C:\Windows\System32\drivers\etc\hosts`. Use the server's IP address, or `127.0.0.1` if Zwift and Zluggish run on the same computer.

## Uninstall

To remove the Zluggish patches, follow the [uninstall instructions](../../maintenance/uninstall.md).
