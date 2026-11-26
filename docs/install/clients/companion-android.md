---
sidebar_position: 5
description: Publish and install Zwift Companion for Android on your Zluggish server.
---

# Companion (Android)

The patched Companion app has the Zluggish icon and installs alongside the official app. It works without root.

Download the patched app from the specific Zluggish server you want to connect to. Each server has its own certificate; an app downloaded from another server will not trust the server you want to use.

## Install Companion

1. In the [web app](../../usage/web-app.md), open **Apps → Zwift Companion → Android** on the Android device.
2. Download and install the patched Companion app. If the download is missing or uses an old certificate, ask your administrator to [publish an updated build](#publish-companion).
3. Point `secure.zwift.com` and `us-or-rly101.zwift.com` at your Zluggish server. Copy the entries from the setup page into [Virtual Hosts](dns-settings.md#virtual-hosts-android). For other options, see [DNS settings](dns-settings.md). Leave `cdn.zwift.com` on public DNS for Companion images.
4. Open Companion with the Zluggish icon and sign in with your Zluggish account.

If Android uses a different resolver, check **Private DNS** in Android settings. The redirect affects both Companion installs. Turn it off before signing in to the official service.

When your administrator publishes an update or [rotates the server certificate](../certificate.md), download and install the new build from the same setup page.

## Publish Companion

An administrator does this once per app version. The server patches Companion to trust its own certificate and signs it as `com.zluggish.companion`, so riders can keep the Play Store app installed alongside it.

1. As an administrator, open **Manage → Android apps → Companion**.
2. Select **Download and build** if offered. The server fetches the app from APKPure and patches it.
3. To upload instead, use **Upload Companion**. The server accepts an APK or a split bundle (`.apks`, `.xapk` or `.apkm`). It can also rebuild a [zoffline-companion release](https://github.com/fatsbrown/zoffline-companion/releases/latest) or replace the certificate in an existing Zluggish Companion APK. Keep the page open until the upload finishes.
4. Wait for patching and signing to finish. The page shows the build progress.
5. On the Android device, open **Apps → Zwift Companion → Android** on this server, then [download and install the patched app](#install-companion).

If you replace an older build that used the official app ID, upload it again. Riders install the new app separately and sign in again.

### Build tools and backups

The server downloads and verifies APKEditor and, if needed, Java for the first rebuild. It can reuse Java 11 or later from `PATH`. An existing Zluggish APK only needs its certificate replaced. Keep the `tools/` directory mounted across container updates to reuse the tools. The example Compose file does this.

Save `storage/companion/signer.pem` separately. [Server backups](../../maintenance/backup-and-restore.md) skip the Companion directory, including the signing key and APKs. If the server signs the app with a new key, riders must uninstall the previous copy before installing the new one.
