---
sidebar_position: 5
description: Publish and install Companion for Zluggish on Android and send Companion traffic to your server.
---

# Companion (Android)

**Companion for Zluggish** is a patched Zwift companion app for Zluggish. It can be installed alongside the official Zwift companion app, and you don't need to root your device.

If you just set up your Zluggish server, an administrator must [publish Companion](#publish-companion) before these instructions work.

## Install Companion

1. In the [web app](../../usage/web-app.md), open **Apps → Zwift Companion → Android** on the Android device.
2. Select **Download Companion**. The page shows the version and download size. If a download is unavailable, ask your administrator to [publish the app](#publish-companion).
3. Open the downloaded file and allow your browser to install it. If Play Protect prompts about the unknown app, select **Install anyway**.
4. [Change the DNS settings](#modify-android-dns-settings).
5. Open **Companion for Zluggish** and sign in with your Zluggish login name and password.

Download the app from the Zluggish server you want to connect to. Each server has its own certificate, so a build from another server will not trust it.

## Update Companion

When your administrator publishes an update or [rotates the server certificate](../certificate.md), download and install the new build from the same setup page.

## Modify Android DNS settings

The Android DNS settings need to be manually patched for the app to work. There are several methods documented on the [DNS settings page](dns-settings.md), but the [Virtual Hosts](dns-settings.md#virtual-hosts-android) method is usually the best place to start.

Point `secure.zwift.com` and `us-or-rly101.zwift.com` at your Zluggish server. Copy the entries from the setup page into Virtual Hosts. Leave `cdn.zwift.com` on public DNS for Companion images.

If Android's **Private DNS** setting bypasses your chosen DNS server, turn it off while you use the redirect. The redirect applies to both installed copies of Companion. Disable it before using the official service.

## Publish Companion

An administrator does this once per app version.

1. On the Zluggish server riders will connect to, open **Manage → Android apps → Companion** as an administrator.
2. Select **Download and build** if offered. The server fetches the app from APKPure and patches it.
3. To upload instead, use **Upload Companion**. The server accepts an APK or a split bundle (`.apks`, `.xapk` or `.apkm`). It can also rebuild a [zoffline-companion release](https://github.com/fatsbrown/zoffline-companion/releases/latest) or replace the certificate in an existing Zluggish Companion APK. Keep the page open until the upload finishes.
4. Wait for Zluggish to patch and sign the app. The server builds it in the background and shows its progress on the same page.
5. When the build finishes, open **Apps → Zwift Companion → Android** on the Android device, then [download and install the patched app](#install-companion) from this server.

The server keeps the last upload so **Build again** can rebuild it.

If you replace an older build that used the official app ID, upload it again. Riders install the new app separately and sign in again.

### Build tools and backups

The server downloads and verifies APKEditor and, if needed, Java for the first rebuild. It can reuse Java 11 or later from `PATH`. An existing Zluggish APK only needs its certificate replaced. Keep the `tools/` directory mounted across container updates to reuse the tools. The example Compose file does this.

Save `storage/companion/signer.pem` separately. [Server backups](../../maintenance/backup-and-restore.md) skip the Companion directory, including the signing key and APKs. If the server signs the app with a new key, riders must uninstall the previous copy before installing the new one.
