---
sidebar_position: 6
description: Choose how Zwift and Companion resolve your Zluggish server's hostnames.
---

# DNS settings

Zwift and Companion need to resolve the hostnames shown on the Zluggish setup page to your server's IP address. Choose one of the methods below. You still need to follow your device's client setup guide to install or patch the app and trust the server certificate.

## Setup script (Windows, macOS and Linux)

Use the setup script in your device's guide by default. It adds the required entries to the computer's hosts file, so you do not need a separate DNS server.

If you use another method below, turn off **Patch hosts file** under **Advanced settings** before downloading the script. If you already ran the script, remove its Zluggish entries from the hosts file so they do not override your DNS settings.

## Router DNS

Add the hostnames from the setup page as local DNS records on a router that supports overrides, pointing them at your Zluggish server's LAN IP. Configure your client devices to use the router's DNS.

## Zluggish DNS

[Enable the optional DNS listener](../../reference/ports.md#optional-dns-with-docker), then set your client device's DNS server to the Zluggish server's LAN IP. On Android, change the DNS settings for the Wi-Fi connection.

## Cloudflare One Client

For remote play, use a [Gateway DNS override](../remote-access.md#redirect-the-zwift-names-with-gateway-dns).

## Virtual Hosts (Android)

[Virtual Hosts](https://github.com/x-falcon/Virtual-Hosts/releases/latest) redirects hostnames on a single Android device without root. It uses Android's VPN slot, so use it by itself. Choose another DNS method if Android cannot install it.

1. Install `app-Github-release.apk` from the release page.
2. Save the host entries from the Zluggish setup page as `hosts.txt` on the device.
3. Open Virtual Hosts, select `hosts.txt` and turn it on.

## Switching back to the official service

The redirect applies to both installed copies of Zwift on Android. Disable the redirect before using the official service. For desktop clients, see [Uninstall](../../maintenance/uninstall.md) to undo the client setup as well.

If Android's **Private DNS** setting bypasses your chosen DNS server, turn it off while you use the redirect.
