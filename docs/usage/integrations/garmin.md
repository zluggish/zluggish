---
sidebar_position: 2
description: Upload Zluggish activities to Garmin Connect.
---

# Garmin Connect

1. In the web app, go to **Integrations → Garmin**.
2. Save your Garmin credentials.
3. Select **Authorize**.
4. If Garmin asks for multi-factor authentication, enter the verification code.

Zluggish uploads FIT files to Garmin Connect. It does not need a Python helper or a separate Garmin image.

Photos taken during a ride are added to the activity that Garmin Connect creates from it, but only if you turn that on: it is off by default and Garmin then receives the FIT file alone. Enable it in **Integrations → Garmin**, or set `uploads.garmin.photos.enabled` to `true`. Adding the photos fails quietly: a photo Garmin refuses does not fail the upload of the activity.

You can keep existing garth token files, `oauth1_token.json` and `oauth2_token.json`, in `storage/<local-player-id>/garth/`.

For a Garmin account in China, set `integrations.garmin.domain: 'garmin.cn'` in `zluggish.config.ts`.

Live Garmin login and upload are not fully verified yet.
