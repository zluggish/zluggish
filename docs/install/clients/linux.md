---
sidebar_position: 2
description: Connect Zwift for Windows running under Wine or Proton to Zluggish.
---

# Linux

Zluggish supports running the Windows game client on Linux through Wine or Proton.

1. Install Zwift for Windows in Wine, Lutris, Bottles or Steam with Proton. Open Zwift once to finish any updates, then close it before signing in.
2. In the [Zluggish web app](../../usage/web-app.md), open **Apps → Zwift → Linux**.
3. Select **Download setup script**. Use the script from the specific Zluggish server you want to connect to, since each server has a unique certificate.
4. In a terminal, run the command shown on the setup page. Enter your password when `sudo` prompts you.
5. Restart the Wine or Proton session, then open Zwift and sign in through the Zluggish launcher.

The script adds the Zluggish certificate to the system trust store and to `data/cacert.pem` for the Zwift installations it finds. By default, the script also updates DNS lookup settings in `/etc/hosts` with the Zluggish IP address.

If you don't want the script to change DNS settings, turn off **Patch hosts file** under **Advanced settings** before downloading the script. You can then manually follow the instructions on the [DNS settings page](dns-settings.md).

## Updating

If Zwift updates, it may lose its connection to Zluggish. In that case, download the setup script from your server and run it again. Do the same when the [server certificate changes](../certificate.md).

## If the script cannot find Zwift

Run the script with your Zwift installation directory. Replace both paths in the command with your own.

```sh
sh ~/Downloads/zluggish-zwift-XXXXXXXX.sh "$HOME/.wine/drive_c/Program Files (x86)/Zwift"
```

## Uninstall

To remove the Zluggish patches, follow the [uninstall instructions](../../maintenance/uninstall.md).
