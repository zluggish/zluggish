import type { RepositoryContext as Runtime } from '#src/context';
import { Connections } from '#src/repositories/connections.repository';
import { writeDurable } from '#src/repositories/files.repository';
import { resolveRiderSettings } from '#src/repositories/settings.repository';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const number = (value: z.infer<ReturnType<typeof z.json>> | undefined, fallback = 0) => {
  const result = Number(value);

  return value !== undefined && Number.isFinite(result) && result >= 0 ? result : fallback;
};

const uuid = z.uuidv4();

const metadataSchema = z.object({
  provider: z.string(),
  event_id: z.union([z.string(), z.number()]).nullable().optional(),
  workout_id: z.string().optional(),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  start_date_local: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  icu_training_load: z.number().nullable().optional(),
});

const identifier = z.union([z.string(), z.number()]);

/** Loose on purpose: unread provider fields must survive a rewrite. */
export const storedEntrySchema = z.looseObject({
  event_id: identifier.nullish(),
  id: identifier.nullish(),
  workout_id: z.string().nullish(),
  name: z.string().nullish(),
  start_date_local: z.string().nullish(),
  start_date: z.string().nullish(),
  synced_for_date: z.string().nullish(),
});

export type StoredEntry = z.infer<typeof storedEntrySchema>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
});

const documentSchema = z.record(z.string(), z.json());

const stepSchema = z.record(z.string(), z.union([z.string(), z.number(), z.json()]));

const localDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

function parseXML(content: string) {
  if (
    /<!DOCTYPE|<!ENTITY/i.test(content) ||
    Buffer.byteLength(content) > 16 * 1024 * 1024 ||
    XMLValidator.validate(content) !== true
  )
    throw new Error('Invalid workout XML');

  return documentSchema.parse(parser.parse(content));
}

export function workoutDetails(content: string) {
  const document = parseXML(content);
  const root = documentSchema.parse(document.workout_file);
  const workout = documentSchema.parse(root.workout);

  if (!['bike', 'cycling'].includes(String(root.sportType ?? 'bike').toLowerCase())) return null;
  const zones = [0, 0, 0, 0, 0, 0];
  let duration = 0;
  let known = true;

  function add(seconds: number, low: number, high = low) {
    if (seconds <= 0) return;
    duration += seconds;

    if (low < 0 || high < 0) {
      known = false;

      return;
    }

    const cuts = [0, 1];

    if (low !== high)
      for (const limit of [0.55, 0.75, 0.9, 1.05, 1.2])
        if (Math.min(low, high) < limit && limit < Math.max(low, high)) cuts.push((limit - low) / (high - low));
    cuts.sort((a, b) => a - b);

    for (let index = 1; index < cuts.length; index++) {
      const start = cuts[index - 1] ?? 0;
      const end = cuts[index] ?? 1;
      const power = low + ((high - low) * (start + end)) / 2;

      const zone = [0.55, 0.75, 0.9, 1.05, 1.2].findIndex((limit) => power <= limit);

      const target = zone === -1 ? 5 : zone;
      zones[target] = (zones[target] ?? 0) + seconds * (end - start);
    }
  }

  for (const [tag, value] of Object.entries(workout))
    for (const entry of Array.isArray(value) ? value : [value]) {
      const parsed = stepSchema.safeParse(entry);

      if (!parsed.success) continue;
      const step = parsed.data;

      if (tag === 'IntervalsT') {
        const repeat = number(step['@_Repeat']);

        if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 604_800) return null;
        add(repeat * number(step['@_OnDuration']), number(step['@_OnPower'], -1));
        add(repeat * number(step['@_OffDuration']), number(step['@_OffPower'], -1));
      } else if (['Warmup', 'Cooldown', 'Ramp'].includes(tag))
        add(number(step['@_Duration']), number(step['@_PowerLow'], -1), number(step['@_PowerHigh'], -1));
      else add(number(step['@_Duration']), number(step['@_Power'], -1));
    }

  if (duration <= 0 || duration > 604_800) return null;
  const exact = zones.map((value) => (100 * value) / duration);
  const percentages = known ? exact.map((element) => Math.floor(element)) : [0, 0, 0, 0, 0, 0];

  if (known) {
    const order = exact
      .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
      .sort((a, b) => b.fraction - a.fraction);

    const remaining = 100 - percentages.reduce((sum, value) => sum + value, 0);

    for (const item of order.slice(0, remaining)) percentages[item.index] = (percentages[item.index] ?? 0) + 1;
  }

  return {
    name: String(root.name ?? ''),
    description: String(root.description ?? ''),
    duration: Math.round(duration),
    zonePercentages: percentages,
    difficulty: Math.min(number(root.difficulty), 5),
  };
}

function scheduleID(identity: string) {
  const digest = createHash('sha1')
    .update(Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex'))
    .update(identity)
    .digest()
    .subarray(0, 16);

  digest[6] = ((digest[6] ?? 0) & 15) | 80;
  digest[8] = ((digest[8] ?? 0) & 63) | 128;
  const hex = digest.toString('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function publishFiles(files: ReadonlyMap<string, string | Uint8Array>, commit?: () => void) {
  const previous = new Map<string, Buffer | null>();

  try {
    for (const [file, content] of files) {
      previous.set(file, existsSync(file) ? readFileSync(file) : null);
      writeDurable(file, content, true);
    }

    commit?.();
  } catch (error) {
    for (const [file, content] of previous)
      if (content === null) rmSync(file, { force: true });
      else writeDurable(file, content, true);
    throw error;
  }
}

export class Workouts {
  constructor(readonly runtime: Runtime) {}
  provider(id: number) {
    const settings = resolveRiderSettings(this.runtime.config.riderDefaults, this.runtime.settings.read(id));

    const available = [];

    if (existsSync(new Connections(this.runtime.config.storageDir).file(id, 'intervals')))
      available.push('intervals-icu');

    if (settings.workouts.trainingpeaks.bridgeFolder) available.push('trainingpeaks');

    const file = resolve(this.runtime.profiles.folder(id), 'active_workout_provider.txt');

    const saved = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';

    return available.includes(saved) ? saved : (available[0] ?? null);
  }
  entries(id: number) {
    const file = resolve(this.runtime.profiles.folder(id), 'intervals_icu_workout.json');

    if (!existsSync(file)) return [];
    const raw = documentSchema.parse(JSON.parse(readFileSync(file, 'utf8')));

    return z.array(metadataSchema).parse(Array.isArray(raw.workouts) ? raw.workouts : [raw]);
  }
  metadataFile(id: number) {
    return resolve(this.runtime.profiles.folder(id), 'intervals_icu_workout.json');
  }
  /** Unmodified stored entries, including fields the schema does not read. */
  stored(id: number) {
    const none: StoredEntry[] = [];
    const file = this.metadataFile(id);

    if (!existsSync(file)) return { collection: false, entries: none };

    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const collection = z.object({ workouts: z.array(z.json()) }).safeParse(raw);

    return collection.success
      ? {
          collection: true,
          entries: collection.data.workouts.flatMap((entry) => {
            const parsed = storedEntrySchema.safeParse(entry);

            return parsed.success ? [parsed.data] : [];
          }),
        }
      : { collection: false, entries: [storedEntrySchema.parse(raw)] };
  }
  removeEvent(id: number, eventId: string | number) {
    const { entries } = this.stored(id);

    const removed = entries.filter((entry) => String(entry.event_id) === String(eventId));

    if (removed.length === 0) return;

    for (const entry of removed) {
      const file = this.file(entry.workout_id ?? '');

      if (file && existsSync(file)) rmSync(file);
    }

    const remaining = entries.filter((entry) => !removed.includes(entry));

    writeDurable(
      this.metadataFile(id),
      JSON.stringify({
        ...(remaining[0] ?? { provider: 'intervals-icu' }),
        workouts: remaining,
      }),
      true,
    );
  }
  list(id: number, now = new Date()) {
    if (this.provider(id) !== 'intervals-icu') return [];
    const day = localDay(now);
    const seen = new Set<string>();

    return this.entries(id).flatMap((metadata) => {
      const identity = uuid.safeParse(metadata.workout_id);

      if (!identity.success || seen.has(identity.data)) return [];

      const planned =
        metadata.start_date_local?.slice(0, 10) ?? (metadata.start_date ? localDay(new Date(metadata.start_date)) : '');

      if (planned !== day || metadata.provider !== 'intervals-icu') return [];
      const file = this.file(identity.data);

      if (
        !file ||
        !existsSync(file) ||
        [file, resolve(file, '..'), resolve(file, '../..')].some((path) => lstatSync(path).isSymbolicLink())
      )
        return [];
      const details = workoutDetails(readFileSync(file, 'utf8'));

      if (!details) return [];
      seen.add(identity.data);

      const scheduleId = scheduleID(`zoffline:schedule:${id}:intervals-icu:${metadata.event_id}:${day}`);

      const uri = `https://cdn.zwift.com/tp-workouts/intervalsicu/${identity.data}.zwo`;
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      const tomorrow = new Date(midnight);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const summary = {
        ...details,
        description: metadata.description || details.description,
        name: metadata.name || details.name,
        workoutAssetUrl: uri,
        workoutId: identity.data,
        legacyId: 0,
        sport: 'CYCLING',
        lastCompletion: null,
        stressPoints: metadata.icu_training_load ?? 0,
        primaryTrainingFocus: null,
        secondaryTrainingFocus: null,
      };

      return {
        id: identity.data,
        schedule: {
          scheduleId,
          workoutId: identity.data,
          workoutUri: uri,
          trainingProviderId: 'intervalsicu',
          availableAfter: Math.floor(midnight.getTime() / 1000),
          notAvailableAfter: Math.floor(tomorrow.getTime() / 1000) - 1,
          workoutSummary: summary,
        },
        home: {
          nextUp: {
            selected: {
              entityId: identity.data,
              entityType: 'WORKOUT',
              recommendedDurationMinutes: null,
              tags: [],
              token: 'Component.Card.Activity',
            },
            recommendation: null,
            source: 'SCHEDULED',
            sourceId: scheduleId,
            explanation: null,
            expires: null,
            title: 'LOC_TODAY_LOWER',
            provider: 'intervalsicu',
            providerProperties: null,
            metadata: [],
          },
        },
      };
    });
  }
  file(id: string) {
    return uuid.safeParse(id).success
      ? resolve(this.runtime.config.storageDir, 'tp-workouts/intervalsicu', `${id}.zwo`)
      : null;
  }
  async sync(id: number, signal = AbortSignal.timeout(30_000)) {
    signal.throwIfAborted();
    const provider = this.provider(id);

    if (provider === 'trainingpeaks') return this.bridge(id, signal);

    if (provider !== 'intervals-icu') return 'Configure a workout provider first.';

    const credentials = new Connections(this.runtime.config.storageDir).read(id, 'intervals');

    if (!credentials) return 'Intervals.icu credentials are missing.';
    const [athlete, key] = credentials;

    if (!/^\d+$/.test(athlete)) throw new Error('Invalid athlete ID');

    const headers = {
      Authorization: `Basic ${Buffer.from(`API_KEY:${key}`).toString('base64')}`,
    };

    const base = `https://intervals.icu/api/v1/athlete/${athlete}`;
    const today = localDay(new Date());

    const response = await fetch(
      `${base}/events?${new URLSearchParams({ oldest: today, newest: today, category: 'WORKOUT' })}`,
      { headers, signal },
    );

    if (!response.ok) throw new Error('Intervals.icu sync failed');

    const events = z
      .array(
        z.object({
          id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
          name: z.string().nullable().optional(),
          start_date_local: z.string().optional(),
          start_date: z.string().optional(),
          category: z.string().default('WORKOUT'),
          description: z.string().nullable().optional(),
          icu_training_load: z.number().nullable().optional(),
        }),
      )
      .parse(await response.json());

    const selected = events.filter(
      (event) =>
        event.category === 'WORKOUT' &&
        (event.start_date_local?.slice(0, 10) ?? localDay(new Date(event.start_date ?? ''))) === today,
    );

    const downloads = [];

    for (const event of selected) {
      const response = await fetch(`${base}/events/${event.id}/download.zwo`, {
        headers,
        signal,
      });

      if (!response.ok) throw new Error('Intervals.icu download failed');
      const text = await response.text();

      if (!workoutDetails(text)) throw new Error('Invalid cycling workout');
      downloads.push({ event, text });
    }

    const previous = this.entries(id);

    const pendingFiles = new Map<string, string>();

    const entries = downloads.map(({ event, text }) => {
      const old = previous.find((item) => String(item.event_id) === String(event.id));

      const identity = uuid.safeParse(old?.workout_id).success ? z.string().parse(old?.workout_id) : randomUUID();

      const doc = parseXML(text);
      const root = documentSchema.parse(doc.workout_file);
      root.uniqueId = identity;

      const content = new XMLBuilder({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        format: true,
      }).build({ workout_file: root });

      const file = this.file(identity);

      if (!file) throw new Error('Invalid workout identity');
      pendingFiles.set(file, z.string().parse(content));

      return {
        ...event,
        provider: 'intervals-icu',
        event_id: event.id,
        workout_id: identity,
        filename: `${identity}.zwo`,
        synced_at: new Date().toISOString(),
      };
    });

    pendingFiles.set(
      this.metadataFile(id),
      JSON.stringify({
        ...(entries[0] ?? { provider: 'intervals-icu' }),
        workouts: entries,
      }),
    );
    pendingFiles.set(resolve(this.runtime.profiles.folder(id), 'active_workout_provider.txt'), 'intervals-icu');
    signal.throwIfAborted();
    // Publication is synchronous: no request can observe new metadata before all files exist.
    publishFiles(pendingFiles);

    return `Synced ${entries.length} Intervals.icu workouts.`;
  }
  bridge(id: number, signal = AbortSignal.timeout(30_000)) {
    const settings = resolveRiderSettings(this.runtime.config.riderDefaults, this.runtime.settings.read(id));

    const folder = settings.workouts.trainingpeaks.bridgeFolder;

    if (!folder || !existsSync(folder)) return 'TrainingPeaks bridge folder is missing.';
    const imports: { filename: string; content: Buffer }[] = [];

    for (const name of readdirSync(folder).sort()) {
      if (!name.toLowerCase().endsWith('.zwo') || !lstatSync(resolve(folder, name)).isFile()) continue;
      signal.throwIfAborted();
      const content = readFileSync(resolve(folder, name));
      parseXML(content.toString('utf8'));

      const filename = `trainingpeaks-${
        name
          .slice(0, -4)
          .toLowerCase()
          .replaceAll(/[^a-z0-9]+/g, '-')
          .replaceAll(/^-|-$/g, '') || 'workout'
      }.zwo`;

      imports.push({ filename, content });
    }

    const pendingFiles = new Map<string, string | Uint8Array>();

    for (const item of imports)
      pendingFiles.set(resolve(this.runtime.profiles.folder(id), 'customworkouts', item.filename), item.content);
    pendingFiles.set(resolve(this.runtime.profiles.folder(id), 'active_workout_provider.txt'), 'trainingpeaks');
    signal.throwIfAborted();
    const db = this.runtime.accounts.db;
    const timestamp = Math.floor(Date.now() / 1000);
    db.exec('BEGIN IMMEDIATE');

    try {
      for (const { filename } of imports) {
        const old = db
          .prepare('SELECT id FROM zfile WHERE player_id=? AND folder=? AND filename=?')
          .get(id, 'customworkouts', filename);

        if (old) db.prepare('UPDATE zfile SET timestamp=? WHERE id=?').run(timestamp, z.number().parse(old.id));
        else
          db.prepare('INSERT INTO zfile (player_id,folder,filename,timestamp) VALUES (?,?,?,?)').run(
            id,
            'customworkouts',
            filename,
            timestamp,
          );
      }

      publishFiles(pendingFiles, () => {
        db.exec('COMMIT');
      });
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    return `Imported ${imports.length} TrainingPeaks workouts.`;
  }
}
