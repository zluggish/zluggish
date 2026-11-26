---
sidebar_position: 1
description: Server and client requirements for Zluggish.
---

# Requirements

You need a computer to run Zluggish and a device to run Zwift. They can be the same computer.

## Server

- Docker with Docker Compose on Linux, Windows or macOS.
- Free disk space for your storage and backups. Plan for at least 10 GB of free build space if you [publish Zwift for Android](clients/android.md#publish-zwift-for-android), plus room for its download.

## Zwift client

Set up Zwift from the **Apps** page of the Zluggish web app. Follow the guide for your device.

- [Windows](clients/windows.md)
- [macOS](clients/macos.md)
- [Linux with Wine](clients/linux.md)
- [Android](clients/android.md)

For Zwift's hardware requirements, see [Zwift's supported devices](https://support.zwift.com/en_us/supported-devices-to-run-zwift-H1Cj9QbeB). Zluggish also supports [Companion on Android](clients/companion-android.md).

## Why iPhone and iPad are not supported

Zluggish does not support Zwift or Companion on iOS or iPadOS. These are locked-down platforms: Zluggish needs to patch the apps so they connect to your server, but iPhone and iPad restrict app modification and installation through code signing and platform security controls. Zluggish has no supported way to patch and install either app on these devices.

Use one of the supported Zwift clients above, or [Companion on Android](clients/companion-android.md).
