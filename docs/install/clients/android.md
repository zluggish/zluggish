---
sidebar_position: 4
description: Publish and install Zwift for Zluggish on Android and send game traffic to your server.
---

# Android

**Zwift for Zluggish** trusts your server's certificate and installs alongside Zwift from Google Play. It works without root.

Download the patched app from the specific Zluggish server you want to connect to. Each server has its own certificate; an app downloaded from another server will not trust the server you want to use.

Before riders can install it, an administrator must [download Zwift manually, upload it to Zluggish and wait for patching](#publish-zwift-for-android).

## Install Zwift

1. In the [web app](../../usage/web-app.md), open **Apps → Zwift → Android** on the Android device.
2. Select **Download Zwift**. The page shows the version and download size. If a download is unavailable, ask your administrator to [publish the app](#publish-zwift-for-android).
3. Open the downloaded file and allow your browser to install it. If Play Protect prompts about the unknown app, select **Install anyway**.
4. [Point the Zwift names at your server](#point-zwift-at-zluggish).
5. Open **Zwift for Zluggish** and sign in with your Zluggish login name and password. The first launch unpacks the game files.

When the administrator publishes a new version or [rotates the certificate](../certificate.md), install the new download from the same page.

## Point Zwift at Zluggish

Use [Virtual Hosts](dns-settings.md#virtual-hosts-android) to redirect the hostnames on a single Android device without root. It uses Android's VPN slot, so use it by itself.

For router DNS, Zluggish DNS or remote play with Cloudflare One Client, see [DNS settings](dns-settings.md).

If Android's **Private DNS** setting bypasses your chosen DNS server, turn it off while you use the redirect. The redirect applies to both installed copies of Zwift. Disable it before using the official service.

## Publish Zwift for Android

An administrator does this once per app version.

1. Manually download the **BUNDLE 1 OBB** variant of Zwift from [APKMirror](https://www.apkmirror.com/apk/zwift-inc/zwift/). You need the `.apkm` file.
2. On the Zluggish server riders will connect to, open **Manage → Android apps → Zwift** as an administrator.
3. Use **Upload Zwift** or drop the `.apkm` file on the upload area. Keep the page open until the upload finishes.
4. Wait for Zluggish to patch and sign the app. The server builds it in the background and shows its progress on the same page.
5. When the build finishes, open **Apps → Zwift → Android** on the Android device, then [download and install the patched app](#install-zwift) from this server.

The build status shows the recommended free space. The first build may download Java and APKEditor, which the [Companion patcher](companion-android.md#build-tools-and-backups) also uses. The server keeps the last upload so **Build again** can rebuild it.

The upload, published app and signing key are excluded from [server backups](../../maintenance/backup-and-restore.md). Save `storage/zwift-android/signer.pem` separately if you need to install future builds over existing copies.
