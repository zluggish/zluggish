---
sidebar_position: 3
description: Get planned workouts from Intervals.icu and TrainingPeaks, and upload activities.
---

# Intervals.icu and planned workouts

## Intervals.icu

1. Open the [Intervals.icu settings](https://intervals.icu/settings) and go to **Developer Settings**.
2. Copy the athlete ID, including its `i` prefix if shown, and the API key.
3. In the web app, go to **Integrations → Intervals.icu**.
4. Save the athlete ID and the API key.

Cycling workouts show in the launcher. Zluggish can upload completed activities and pair them with their planned workout.

If another service already sends your activities to Intervals.icu, for example Garmin Connect, clear **Upload completed activities** to avoid duplicates. Workout sync continues to work. Zluggish then does not pair completed activities with their planned workouts. You can also set the `uploads.intervals.enabled` preference.

Zluggish gets the workouts again when you sign in to the launcher. The Android game login also does this when it uses saved login tokens. Each automatic update has a time limit of five seconds. If the update fails, Zluggish keeps the cached workouts.

To get the workouts immediately, select **Sync workouts** under **Integrations → Intervals.icu**.

## TrainingPeaks workouts

Zluggish can import `.zwo` files that you export from TrainingPeaks into a local folder.

1. In the web app, go to **Integrations → TrainingPeaks**.
2. Set **Export folder** to the folder with the `.zwo` files. You can also set the `workouts.trainingpeaks.bridgeFolder` preference.
3. Select **Import workouts**.

The server must have access to the folder. If you use Docker, the folder must be in the container.
