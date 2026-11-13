# Activity completion and upload retries

Finishing an activity records a completion journal before writing its FIT file and streak snapshot. Startup resumes unfinished completions. The activity record, power-curve rows, completion marker and upload jobs commit together. A later save for the same rider first finishes any earlier interrupted completion.

Repeating the same completed save returns success without adding another streak contribution, power curve or provider job. Completed activity payloads are immutable: a changed payload returns HTTP 409. Deleting an activity removes its FIT/chart/media files and upload jobs; it does not reverse historical streak or power-curve contributions. Replacing a completed activity is therefore not a correction mechanism for those aggregates. Activities completed before this journal was introduced have no completion marker and cannot be deduplicated retrospectively.

Rider home lists the most recent 100 provider jobs, with `pending`, `sending`, `sent`, `failed` or `cancelled` status. The background worker sends pending jobs and preserves failures across restarts. Disconnecting a provider cancels a queued delivery. A send interrupted by process termination becomes failed on startup; it is not sent again automatically. Deleting local jobs cannot retract a request already in flight or an activity already accepted by a provider.

Use **Retry failed uploads** on rider home after checking the provider. The provider may have accepted an activity even when its acknowledgement was lost, so an explicit retry can create a duplicate there. Retries require the current rider's authenticated browser session and CSRF token. A successful local activity save means the upload intent was recorded, not that the provider has accepted it.

The journal and job tables are added when an existing version-4 account database opens. Back up the complete storage directory, including `zluggish.db`, rather than only the FIT files. Completion journals retain the finalized activity payload, including FIT bytes, for recovery and upload retries; account database size grows with saved activities.
