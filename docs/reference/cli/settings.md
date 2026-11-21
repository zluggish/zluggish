---
sidebar_position: 3
description: Show and change the settings of a rider.
---

# Rider settings commands

These commands need an existing local rider, identified by a numeric `--user ID`, and a valid operator config. The CLI keeps the overrides in `storage/settings.db`. It does not change the TypeScript config.

| Command                                        | Result                                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `settings show --user ID`                      | Show the effective settings of the user as JSON. This combines the config defaults and the saved overrides.             |
| `settings set --user ID KEY VALUE [--dry-run]` | Check and save one override. `VALUE` must be JSON. With `--dry-run`, the command checks but does not save.              |
| `settings reset --user ID KEY [--dry-run]`     | Remove one override, so that the rider uses the config default. With `--dry-run`, the command checks but does not save. |

## Keys

| Key                                   | JSON value                       |
| ------------------------------------- | -------------------------------- |
| `ghosts.enabled`                      | `true` or `false`                |
| `uploads.zwift.enabled`               | `true` or `false`                |
| `uploads.strava.method`               | `"paid"` or `"free"`             |
| `uploads.garmin.device.enabled`       | `true` or `false`                |
| `devices.zwiftClick.enabled`          | `true` or `false`                |
| `workouts.trainingpeaks.bridgeFolder` | A JSON string with a folder path |

## Examples

```sh
node server/dist/src/cli/bin.js settings show --user 1
node server/dist/src/cli/bin.js settings set --user 1 ghosts.enabled true --dry-run
node server/dist/src/cli/bin.js settings set --user 1 ghosts.enabled true
node server/dist/src/cli/bin.js settings reset --user 1 ghosts.enabled
```

## JSON strings in the shell

In macOS and Linux shells, put single quotes around a JSON string, so that the shell keeps the double quotes:

```sh
node server/dist/src/cli/bin.js settings set --user 1 uploads.strava.method '"free"'
node server/dist/src/cli/bin.js settings set --user 1 workouts.trainingpeaks.bridgeFolder '"/path/to/workouts"'
```

The same quotes work in PowerShell 7.3 and later, with standard native argument passing. Older PowerShell versions can remove the JSON double quotes. Use the stop-parsing token for literal arguments:

```powershell
node --% server/dist/src/cli/bin.js settings set --user 1 uploads.strava.method \"free\"
```
