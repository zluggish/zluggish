---
sidebar_position: 4
description: Publish and install Zwift for Zluggish on Android and send game traffic to your server.
---

# Android

**Zwift for Zluggish** is a patched Zwift app that lets you play Zwift on Android with Zluggish. It installs next to the official Zwift app and does not need a rooted device.

On a new server, an administrator must first [publish Zwift for Android](#publish-zwift-for-android).

## Install Zwift

1. In the [web app](../../usage/web-app.md), open **Apps → Zwift → Android** on the Android device.
2. Select **Download Zwift**. The page shows the version and download size. If a download is unavailable, ask your administrator to [publish the app](#publish-zwift-for-android).
3. Open the downloaded file and allow your browser to install it. If Play Protect prompts about the unknown app, select **Install anyway**.
4. [Change the DNS settings](#modify-android-dns-settings).
5. Open **Zwift for Zluggish** and sign in with your Zluggish login name and password. The first launch unpacks the game files.

## Update Zwift

When Zwift releases a new version, an administrator [publishes it on the server](#publish-zwift-for-android). Then download and install the new build from **Apps → Zwift → Android**.

## Modify Android DNS settings

The app reaches your server only if Android resolves the Zwift host names to it. The [DNS settings page](dns-settings.md) lists several ways to do this. [Virtual Hosts](dns-settings.md#virtual-hosts-android) is usually the easiest to start with.

If Android's **Private DNS** setting bypasses your chosen DNS server, turn it off while you use the redirect. The redirect applies to both installed copies of Zwift. Disable it before using the official service.

## Publish Zwift for Android

An administrator does this once per app version.

1. Download the **BUNDLE 1 OBB** variant of Zwift from [APKMirror](https://www.apkmirror.com/apk/zwift-inc/zwift/). You need the `.apkm` file.
2. On the Zluggish server riders will connect to, open **Manage → Android apps → Zwift** as an administrator.
3. Use **Upload Zwift** or drop the `.apkm` file on the upload area. Keep the page open until the upload finishes.
4. Wait for Zluggish to patch and sign the app. The server builds it in the background and shows its progress on the same page.
5. When the build finishes, open **Apps → Zwift → Android** on the Android device, then [download and install the patched app](#install-zwift) from this server.

The build status shows the recommended free space. The first build may download Java and APKEditor, which the [Companion patcher](companion-android.md#build-tools-and-backups) also uses. The server keeps the last upload so **Build again** can rebuild it.

The upload, published app and signing key are excluded from [server backups](../../maintenance/backup-and-restore.md). Save `storage/zwift-android/signer.pem` separately if you need to install future builds over existing copies.
