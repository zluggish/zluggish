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

Zluggish can also add the photos that you take during a ride to the activity that Garmin Connect creates. This is off by default, and Garmin then receives only the FIT file. Turn it on in **Integrations → Garmin**, or set `uploads.garmin.photos.enabled` to `true`. If Garmin refuses a photo, the activity still uploads and Zluggish shows no error.

You can keep existing garth token files, `oauth1_token.json` and `oauth2_token.json`, in `storage/<local-player-id>/garth/`.

## Device in the FIT file

This setting is off by default. Garmin Connect then receives the FIT file exactly as the game writes it.

Turn it on with **Record rides on a Garmin Edge** in **Integrations → Garmin**, or set `uploads.garmin.device.enabled` to `true`. Then choose an Edge model (and, if you want, its serial number). Zluggish writes that device into the FIT file it uploads, so Garmin Connect shows the ride as recorded on that Edge. Strava, Runalyze, Intervals.icu and the other services keep receiving the file of the game.

Turning the setting off again keeps your model and serial number, so the choice is there when you switch it back on. Leave the model on **None** to remove the choice.

For a Garmin account in China, set `integrations.garmin.domain: 'garmin.cn'` in `zluggish.config.ts`.

Live Garmin login and upload are not fully verified yet.
