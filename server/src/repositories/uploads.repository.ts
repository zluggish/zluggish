import { log } from '#src/logging';
import type { RepositoryContext as Runtime } from '#src/context';
import type { Activity } from '#src/protocol/generated/activity_pb';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import { Connections } from '#src/repositories/connections.repository';
import { uploadGarmin } from '#src/repositories/garmin.repository';
import { binaryBlob } from '#src/repositories/session.repository';
import { resolveRiderSettings } from '#src/repositories/settings.repository';
import { uploadFree, uploadPaid } from '#src/repositories/strava.repository';
import type { StoredEntry } from '#src/repositories/workout.repository';
import { Workouts } from '#src/repositories/workout.repository';
import { officialHeaders, officialLogin, officialRelay } from '#src/repositories/zwift.repository';
import { clearField, clone, fromBinary, toBinary } from '@bufbuild/protobuf';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const isoDate = (value: string | null | undefined) =>
  value && /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(value) && !Number.isNaN(Date.parse(value.slice(0, 10)))
    ? value.slice(0, 10)
    : null;

const title = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();

/** Only one planned workout for the activity's day, or an exact unique title, pairs. */
export function pairedEvent(
  activity: Pick<Activity, 'name' | 'startDate' | 'date'>,
  stored: { collection: boolean; entries: StoredEntry[] },
) {
  const day = isoDate(activity.startDate) ?? isoDate(activity.date);

  const matches = stored.entries.filter(
    (entry) => day !== null && isoDate(entry.start_date_local || entry.start_date || entry.synced_for_date) === day,
  );

  const titled = matches.filter((entry) => title(activity.name) !== '' && title(entry.name) === title(activity.name));

  const unique = matches.length === 1 && !stored.collection ? matches[0] : titled[0];

  const ambiguous = (matches.length !== 1 || stored.collection) && titled.length !== 1;

  return ambiguous ? null : (unique?.event_id ?? unique?.id ?? null);
}

export class ActivityUploads {
  constructor(
    readonly runtime: Runtime,
    readonly warn: (message: string) => void = log.warn,
  ) {}

  private pending: Promise<void> | null = null;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;

  configured(player: number) {
    const settings = resolveRiderSettings(this.runtime.config.riderDefaults, this.runtime.settings.read(player));
    const providers = [];

    if (
      existsSync(
        this.credentialFile(
          player,
          settings.uploads.strava.method === 'free' ? 'strava4_session.txt' : 'strava_token.txt',
        ),
      )
    )
      providers.push(settings.uploads.strava.method === 'free' ? 'freeStrava' : 'strava');

    if (existsSync(this.credentialFile(player, 'garth/oauth1_token.json'))) providers.push('garmin');

    if (existsSync(this.credentialFile(player, 'runalyze_token.txt'))) providers.push('runalyze');
    const connections = new Connections(this.runtime.config.storageDir);

    if (existsSync(connections.file(player, 'intervals'))) providers.push('intervals');

    if (settings.uploads.zwift.enabled && existsSync(connections.file(player, 'zwift'))) providers.push('zwift');

    return providers;
  }
  status(player: number) {
    return this.runtime.accounts.db
      .prepare(
        `SELECT u.activity_id,u.provider,u.state FROM activity_upload u
      JOIN activity_completion c ON c.activity_id=u.activity_id WHERE c.player_id=? ORDER BY u.activity_id DESC LIMIT 100`,
      )
      .all(player)
      .map((row) => z.object({ activity_id: z.number(), provider: z.string(), state: z.string() }).parse(row));
  }
  retry(player: number) {
    this.runtime.accounts.db
      .prepare(
        `UPDATE activity_upload SET state='pending' WHERE state='failed' AND activity_id IN
      (SELECT activity_id FROM activity_completion WHERE player_id=?)`,
      )
      .run(player);

    return this.drain();
  }
  start() {
    // A crash after sending but before acknowledgement is ambiguous: require an explicit retry.
    this.runtime.accounts.db.exec("UPDATE activity_upload SET state='failed' WHERE state='sending'");
    this.timer = setInterval(() => {
      void this.drain();
    }, 5000);
    this.timer.unref();
    void this.drain();
  }
  async close() {
    this.stopped = true;

    if (this.timer) clearInterval(this.timer);
    await this.pending;
  }
  drain() {
    if (this.pending) return this.pending;

    if (this.stopped) return Promise.resolve();
    this.pending = this.deliver()
      .catch(() => this.warn('Upload queue unavailable; pending jobs retained'))
      .finally(() => {
        this.pending = null;
      });

    return this.pending;
  }
  private async deliver() {
    const db = this.runtime.accounts.db;

    const jobs = db
      .prepare(
        `SELECT u.activity_id,u.provider FROM activity_upload u
      JOIN activity_completion c ON c.activity_id=u.activity_id WHERE u.state='pending' AND c.done=1
      ORDER BY u.activity_id,u.provider LIMIT 10`,
      )
      .all();

    for (const candidate of jobs) {
      if (this.stopped) break;

      const key = z.object({ activity_id: z.number(), provider: z.string() }).parse(candidate);

      // Read each payload only when it is ready to send; another request may delete a queued job.
      const row = db
        .prepare(
          `SELECT u.activity_id,u.provider,c.player_id,c.payload FROM activity_upload u
        JOIN activity_completion c ON c.activity_id=u.activity_id
        WHERE u.activity_id=? AND u.provider=? AND u.state='pending' AND c.done=1`,
        )
        .get(key.activity_id, key.provider);

      if (!row) continue;

      const job = z
        .object({
          activity_id: z.number(),
          provider: z.enum(['strava', 'freeStrava', 'garmin', 'runalyze', 'intervals', 'zwift']),
          player_id: z.number(),
          payload: z.instanceof(Uint8Array),
        })
        .parse(row);

      db.prepare("UPDATE activity_upload SET state='sending' WHERE activity_id=? AND provider=?").run(
        job.activity_id,
        job.provider,
      );

      try {
        const activity = fromBinary(ActivitySchema, job.payload);

        // Resolve credentials at delivery, so revoked connections cannot be used by queued work.
        if (!this.configured(job.player_id).includes(job.provider)) {
          db.prepare("UPDATE activity_upload SET state='cancelled' WHERE activity_id=? AND provider=?").run(
            job.activity_id,
            job.provider,
          );
          continue;
        }

        if (job.provider === 'freeStrava') {
          const photos = [
            ...db
              .prepare('SELECT id FROM activity_image WHERE activity_id=? AND player_id=?')
              .all(job.activity_id, job.player_id)
              .map((photo) => resolve(this.folder(job.player_id), 'images', `${photo.id}.jpg`)),
            ...db
              .prepare('SELECT id,content_type FROM activity_media WHERE activity_id=? AND player_id=?')
              .all(job.activity_id, job.player_id)
              .map((photo) =>
                resolve(
                  this.folder(job.player_id),
                  'medias',
                  `${photo.id}.${String(photo.content_type).includes('quicktime') ? 'mov' : 'mp4'}`,
                ),
              ),
          ].filter((file) => existsSync(file));

          await this.freeStrava(job.player_id, activity, photos);
        } else await this[job.provider](job.player_id, activity);
        db.prepare(
          "UPDATE activity_upload SET state='sent' WHERE activity_id=? AND provider=? AND state='sending'",
        ).run(job.activity_id, job.provider);
      } catch {
        db.prepare(
          "UPDATE activity_upload SET state='failed' WHERE activity_id=? AND provider=? AND state='sending'",
        ).run(job.activity_id, job.provider);
        this.warn(`${job.provider} upload failed for activity ${job.activity_id}; retry from rider home`);
      }
    }
  }

  private folder(player: number) {
    return this.runtime.profiles.folder(player);
  }

  private credentialFile(player: number, file: string) {
    return resolve(this.folder(player), file);
  }

  async run(player: number, activity: Activity, photos: readonly string[]) {
    const settings = resolveRiderSettings(this.runtime.config.riderDefaults, this.runtime.settings.read(player));

    const steps: [string, () => Promise<void>][] = [
      [
        'Strava',
        () =>
          settings.uploads.strava.method === 'free'
            ? this.freeStrava(player, activity, photos)
            : this.strava(player, activity),
      ],
      ['Garmin', () => this.garmin(player, activity)],
      ['Runalyze', () => this.runalyze(player, activity)],
      ['Intervals.icu', () => this.intervals(player, activity)],
      ['Zwift', () => (settings.uploads.zwift.enabled ? this.zwift(player, activity) : Promise.resolve())],
    ];

    for (const [service, step] of steps)
      try {
        await step();
      } catch (error) {
        this.warn(`${service} upload failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
  }

  async strava(player: number, activity: Activity) {
    await uploadPaid(this.credentialFile(player, 'strava_token.txt'), activity.fit, activity.name);
  }

  async freeStrava(player: number, activity: Activity, photos: readonly string[]) {
    const file = this.credentialFile(player, 'strava4_session.txt');

    if (!existsSync(file)) return;
    const cookie = readFileSync(file, 'utf8').split(/\r?\n/, 1)[0] ?? '';

    if (cookie) await uploadFree(cookie, activity.fitFilename, activity.fit, activity.name, photos);
  }

  async garmin(player: number, activity: Activity) {
    const tokens = this.credentialFile(player, 'garth');

    if (!existsSync(resolve(tokens, 'oauth1_token.json'))) return;

    await uploadGarmin(tokens, this.runtime.config.integrations.garmin.domain, activity.fitFilename, activity.fit);
  }

  async runalyze(player: number, activity: Activity) {
    const file = this.credentialFile(player, 'runalyze_token.txt');

    if (!existsSync(file)) return;
    const token = readFileSync(file, 'utf8').split(/\r?\n/, 1)[0] ?? '';

    if (!token) return;
    const form = new FormData();
    form.set('file', binaryBlob(activity.fit), 'file');

    const response = await fetch('https://runalyze.com/api/v1/activities/uploads', {
      method: 'POST',
      headers: { token },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  }

  async intervals(player: number, activity: Activity) {
    const credentials = new Connections(this.runtime.config.storageDir).read(player, 'intervals');

    if (!credentials) return;
    const [athlete, key] = credentials;

    if (!/^\d+$/.test(athlete)) throw new Error('Invalid athlete ID');
    const workouts = new Workouts(this.runtime);
    const paired = pairedEvent(activity, workouts.stored(player));
    const query = new URLSearchParams({ name: activity.name });

    if (paired !== null) query.set('paired_event_id', String(paired));
    const form = new FormData();
    form.set('file', binaryBlob(activity.fit), 'file');

    const response = await fetch(`https://intervals.icu/api/v1/athlete/${athlete}/activities?${query}`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`API_KEY:${key}`).toString('base64')}`,
      },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    if (paired !== null) workouts.removeEvent(player, paired);
  }

  async zwift(player: number, activity: Activity) {
    const credentials = new Connections(this.runtime.config.storageDir).read(player, 'zwift');

    if (!credentials) return;

    const token = await officialLogin(credentials[0], credentials[1]);
    const headers = officialHeaders(token);

    const me = await fetch(`${officialRelay}/api/profiles/me`, {
      headers: { ...headers, Accept: 'application/x-protobuf-lite' },
      signal: AbortSignal.timeout(30_000),
    });

    if (!me.ok) throw new Error('Cannot read the official profile');

    const official = fromBinary(PlayerProfileSchema, new Uint8Array(await me.arrayBuffer())).id;

    const full = clone(ActivitySchema, activity);
    full.playerId = official;
    const draft = clone(ActivitySchema, full);
    clearField(draft, ActivitySchema.field.id);
    clearField(draft, ActivitySchema.field.fit);

    const created = await fetch(`${officialRelay}/api/profiles/${official}/activities`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/x-protobuf-lite',
        Accept: 'application/json',
      },
      body: toBinary(ActivitySchema, draft),
      signal: AbortSignal.timeout(30_000),
    });

    if (!created.ok) throw new Error('Cannot create the official activity');

    full.id = BigInt(z.object({ id: z.number().int().positive() }).parse(await created.json()).id);

    const uploaded = await fetch(
      `${officialRelay}/api/profiles/${official}/activities/${full.id}?upload-to-strava=true`,
      {
        method: 'PUT',
        headers: {
          ...headers,
          'Content-Type': 'application/x-protobuf-lite',
          Accept: 'application/json',
        },
        body: toBinary(ActivitySchema, full),
        signal: AbortSignal.timeout(60_000),
      },
    );

    if (!uploaded.ok) throw new Error(`HTTP ${uploaded.status}`);
  }
}
