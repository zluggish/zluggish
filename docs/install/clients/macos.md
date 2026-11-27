---
sidebar_position: 3
description: Connect Zwift for macOS to Zluggish.
---

# macOS

1. Install Zwift normally. Open it once to finish any updates and create its data folder, then quit before signing in.
2. In the [Zluggish web app](../../usage/web-app.md), open **Apps → Zwift → macOS**. Use **Other systems** if macOS is hidden.
3. Select **Download setup script**. Each server has its own certificate, so use the script from the server you want to connect to.
4. In Terminal, run the command shown on the setup page. Enter your password when `sudo` prompts you.
5. Open Zwift and sign in through the Zluggish launcher.

The script adds the Zluggish certificate to the **System** keychain and to `~/Library/Application Support/Zwift/data/cacert.pem`. By default, the script also adds the Zwift host names to `/etc/hosts`, pointing at the Zluggish IP address.

To keep the script away from your DNS settings, turn off **Patch hosts file** under **Advanced settings** before you download it. Then set up the redirect yourself with the [DNS settings page](dns-settings.md).

## Updating

If Zwift updates, it may lose its connection to Zluggish. In that case, download the setup script from your server and run it again. Do the same when the [server certificate changes](../certificate.md).

## If the script cannot find Zwift

Run the script with your Zwift data folder. Replace the sample filename with the name you downloaded.

```sh
sh ~/Downloads/zluggish-zwift-XXXXXXXX.sh "$HOME/Library/Application Support/Zwift"
```

## Uninstall

To remove the Zluggish patches, follow the [uninstall instructions](../../maintenance/uninstall.md).
