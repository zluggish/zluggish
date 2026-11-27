---
sidebar_position: 2
description: Log levels and events of the Zluggish server.
---

# Logging

## Configure logging

Set the logging options in `zluggish.config.ts`:

```ts
logging: {
  level: 'INFO', // VERBOSE, INFO, WARN, ERROR, CRITICAL, or NOTSET
  rideProgressIntervalSeconds: 60, // 0 disables progress; otherwise at least 10
},
```

The server also accepts `DEBUG` for `VERBOSE`, and `WARNING` for `WARN`. These are legacy names.

## What the server logs

At the default `INFO` level, the server logs:

- User logins and game connections.
- Companion registrations.
- Ride start, progress and end.
- Saved activities and upload results.

Routine HTTP requests show only at the `VERBOSE` level.

Console lines start with a UTC timestamp and severity, followed by a short message. For example:

```text
2026-11-27T18:38:19.948Z INFO Server ready on 0.0.0.0:443
2026-11-27T18:39:16.698Z VERBOSE POST /* → 401 (17 ms)
```

The web app’s server log viewer keeps event names and diagnostic fields, including request IDs. Error stacks and causes appear below the console message.

`INFO` and `VERBOSE` go to stdout. Warnings and errors go to stderr. Use your process manager to keep and rotate the logs.

## Rides

- A ride starts with the first accepted world state. A rider who does not move also starts a ride.
- Progress records show the elapsed seconds and the distance in meters. A reset of the counter is flagged.
- A new transport connection does not start a new ride.
- A ride ends at logout, at the cleanup of inactive riders, or at shutdown. This does not mean that the activity was saved.
- Only a successful, durable save writes `activity.saved`. A recovered activity is marked separately.

If an external upload fails, send it again from the web app, under **Integrations → Activity uploads**.

## Companion app

A Companion phone registration writes `companion.registered`. The Companion app does not keep a connection, so the log does not show a Companion disconnect. The server writes repeated registrations only once in a two-minute window.

## Privacy

- `VERBOSE` request summaries use route templates. They do not include query strings or request bodies.
- The server does not log credentials or packet contents.
- Player IDs identify users. The server does not log names or email addresses.
