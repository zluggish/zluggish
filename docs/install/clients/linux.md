---
sidebar_position: 2
description: Connect Zwift for Windows running under Wine or Proton to Zluggish.
---

# Linux

Use the setup script below by default. For other ways to point Zwift at your server, see [DNS settings](dns-settings.md).

Download the setup script from the specific Zluggish server you want to connect to. Each server has its own certificate; a script from another server will not install the certificate you need.

1. Install Zwift for Windows in Wine, Lutris, Bottles or Steam with Proton. Open Zwift once to finish any updates, then close it before signing in.
2. In the [web app](../../usage/web-app.md), open **Apps → Zwift → Linux**. Use **Other systems** if Linux is hidden.
3. Select **Download setup script**.
4. In a terminal, run the command shown on the setup page. Enter your password when `sudo` prompts you.
5. Restart the Wine or Proton session, then open Zwift and sign in through the Zluggish launcher.

The script installs the server certificate in the system trust store and patches `data/cacert.pem` for the Zwift installations it finds. It updates `/etc/hosts` unless you turn off **Patch hosts file** under **Advanced settings**. Before editing a file for the first time, the script saves a copy with the `.zluggish-backup` suffix.

## If the script cannot find Zwift

Run the script with your Zwift installation directory. Replace both paths in the command with your own.

```sh
sh ~/Downloads/zluggish-zwift-XXXXXXXX.sh "$HOME/.wine/drive_c/Program Files (x86)/Zwift"
```

Run setup again when the [server certificate changes](../certificate.md) or if a [Zwift update](../../troubleshooting/client-updates.md) overwrites the client files.

## Uninstall

To switch back to the official service and remove the Zluggish certificate, follow the [uninstall instructions](../../maintenance/uninstall.md).
