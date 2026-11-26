---
sidebar_position: 4
description: Back up and restore the Zluggish storage.
---

# Back up and restore

## Automatic and on-demand backups

Zluggish makes a backup every night at 02:00 UTC while the server is running. It keeps the 10 most recent nightly `.tar.gz` backups under `storage/backups/`. Each nightly filename starts with the scheduled UTC date and time, for example `2026-11-20T02-00-00Z-nightly.tar.gz`.

To create a backup at any time, sign in as an administrator and select **Manage → Server → Backups → Create backup**. The page shows when the backup finishes and where it was saved. Manual backups remain until you remove them.

When Zluggish migrates legacy data, it also saves a snapshot of the original storage to the same backup directory before making changes. See [Migrate from zwift-offline](migrating.md) for rollback instructions.

Backups skip `storage/companion/` and `storage/zwift-android/`, including their APKs, app metadata, and signing keys.

## Recover backups from an older Docker container

Older versions wrote backups to `/usr/src/app/zluggish/backups` in the container. If you had a host bind mount for that path, you can still restore from the archives in the old host directory. If Docker stored the archives in a volume, copy them out before you update or remove the container.

Run these commands in the directory containing `docker-compose.yml`. The example uses the default host storage path, `../storage`. Adjust it to match your storage mount.

```sh
docker compose stop zluggish
mkdir -p ../storage/backups
recovery_dir=$(mktemp -d ../storage/backups/recovered.XXXXXX)
docker compose cp zluggish:/usr/src/app/zluggish/backups/. "$recovery_dir/"
```

Confirm the copy succeeded before recreating the container. Keep an existing backups mount if you still use the legacy storage cleanup command, which reads the original migration snapshot path. New backups go directly into `storage/backups/` through the storage mount.

## Back up with the CLI

Stop the server before running the [storage command](../reference/cli/storage.md).

```sh
node server/dist/src/cli/bin.js --storage-dir ./storage storage backup --output ./storage/backups/zluggish-2026-11-16.tar.gz
```

Nightly and manual backups are gzip-compressed tar archives. Use a `.tar.gz` output path to create an archive with the CLI. The restore command also accepts older backup directories. Creating and restoring archives requires `tar`, which is available in the Docker image. They contain a consistent SQLite snapshot, copies of the storage files such as media and FIT exports, the selected config when available, and a checksum manifest.

## Restore

1. Stop the server.
2. Restore the backup:

   ```sh
   node server/dist/src/cli/bin.js --storage-dir ./storage storage restore --input ./storage/backups/zluggish-2026-11-16.tar.gz
   ```

3. Show the deliveries that are not complete:

   ```sh
   node server/dist/src/cli/bin.js --storage-dir ./storage uploads list
   ```

4. Look at each provider. Cancel the deliveries that the provider already has, with `uploads cancel`.
5. Allow the automatic deliveries again:

   ```sh
   node server/dist/src/cli/bin.js --storage-dir ./storage uploads resume --confirm
   ```

6. Start the server.

A backup cannot know which deliveries the providers received after the backup. For this reason, a restore pauses the uploads.

## Copy the storage manually

If you copy the storage directory manually, pause the uploads before the first start:

```sh
node server/dist/src/cli/bin.js --storage-dir ./storage uploads pause
```

## Activity files

Each activity has its own folder in the rider folder. The folder name is the start time of the activity in UTC, followed by the activity ID, so a directory listing sorts the activities by time:

```text
storage/<player id>/activities/
  2026-11-22T223716Z_33/
    activity.fit        FIT export of the activity
    chart.json          chart cache, created again when missing
    images/41.jpg       screenshots
    videos/7.mp4        videos
  orphaned/             files that the update to this layout could not match to an activity
```

The database holds the canonical FIT data. `activity.fit` is a copy, which the server writes again when it is missing.

Older versions kept the FIT exports in `fit/`, the screenshots in `images/` and the videos in `medias/`. The first start of a newer server makes a backup and then moves these files into the activity folders. A FIT export moves only when it is identical to the FIT data in the database. The server keeps any other files in `activities/orphaned/` and never removes them. Examine these files, and delete them when you do not need them.
