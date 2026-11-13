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
    readonly warn: (message: string) => void = console.warn,
  ) {}

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
