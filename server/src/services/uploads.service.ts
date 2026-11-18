import { UploadProvider, UploadState } from '#src/enum';
import type { RemovableCredentialFile } from '#src/enum';
import type { RepositoryContext as Runtime } from '#src/context';
import { atomic, immediate } from '#src/db/transaction';
import { ApplicationError, DeliveryRefusedError, refused, UnreadableCredentialsError } from '#src/errors';
import type { Activity } from '#src/protocol/generated/activity_pb';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import { SystemFlag } from '#src/repositories/system-flag.repository';
import type { Delivery } from '#src/repositories/uploads.repository';
import { officialRelay } from '#src/repositories/zwift.repository';
import { BaseService } from '#src/services/base.service';
import type { RunningJob } from '#src/repositories/jobs.repository';
import type { JobsService } from '#src/services/jobs.service';
import { SettingsService } from '#src/services/settings.service';
import type { StoredEntry } from '#src/dtos/workout.dto';
import { WorkoutsService } from '#src/services/workout.service';
import { loadRouteNames, titleWithRoute } from '#src/world/route-names';
import { clearField, clone, fromBinary, toBinary } from '@bufbuild/protobuf';
import { resolve } from 'node:path';
import { z } from 'zod';

const isoDate = (value: string | null | undefined) =>
  value && /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(value) && !Number.isNaN(Date.parse(value.slice(0, 10)))
    ? value.slice(0, 10)
    : null;

const title = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();

/** Provider duplicate behavior. An ambiguous delivery
retries automatically only for a provider that reliably rejects duplicates or accepts an
idempotency key. No provider is verified yet, so every ambiguous delivery needs an
operator decision.
*/
export const automaticAmbiguousRetry: Record<UploadProvider, boolean> = {
  strava: false,
  freeStrava: false,
  garmin: false,
  runalyze: false,
  intervals: false,
  zwift: false,
};

/** One delivery attempt. Steps of a multi-request provider persist before the next request. */
type Attempt = { activity: number; provider: UploadProvider; token: string; delivery: Delivery; signal: AbortSignal };

/** Throws DeliveryRefusedError when the response proves that the provider rejected the request. */
async function checked(response: Response, code: string) {
  if (response.ok) return response;
  await response.body?.cancel();

  if (refused(response.status)) throw new DeliveryRefusedError(`${code}_${response.status}`);
  throw new Error(`${code}_${response.status}`);
}

/** Only one planned workout for the activity's day, or an exact unique title, pairs. */

export class UploadsService extends BaseService {
  private jobs: JobsService | null = null;

  private routeNames: ReadonlyMap<number, string> | null = null;

  constructor(
    readonly runtime: Runtime,
    readonly warn: (message: string) => void = () => {},
  ) {
    super(runtime.accounts.repositories);
  }

  /** Providers with current credentials and consent for this rider. */
  configured(player: number) {
    const settings = SettingsService.resolveRiderSettings(
      this.runtime.config.riderDefaults,
      this.runtime.settings.read(player),
    );

    const providers: UploadProvider[] = [];
    const has = (name: Parameters<typeof this.riderDocuments.has>[1]) => this.riderDocuments.has(player, name);

    if (has(settings.uploads.strava.method === 'free' ? 'strava4_session.txt' : 'strava_token.txt'))
      providers.push(settings.uploads.strava.method === 'free' ? 'freeStrava' : 'strava');

    if (has('garth/oauth1_token.json')) providers.push('garmin');

    if (has('runalyze_token.txt')) providers.push('runalyze');

    if (this.connectionsRepository.has(player, 'intervals')) providers.push('intervals');

    if (settings.uploads.zwift.enabled && this.connectionsRepository.has(player, 'zwift')) providers.push('zwift');

    return providers;
  }

  status(player: number) {
    return this.uploadsRepository.status(player).map((row) =>
      z
        .object({
          activity_id: z.number(),
          provider: z.string(),
          state: z.string(),
          last_error: z.string().nullable(),
        })
        .parse(row),
    );
  }

  /** Each configured provider with this activity's delivery to it, if any. */
  forActivity(player: number, activity: number) {
    return this.configured(player).map((provider) => {
      const delivery = this.uploadsRepository.get(activity, provider);

      return { provider, state: delivery?.state ?? null, error: delivery?.last_error ?? null };
    });
  }

  /** Upload a finished activity on the rider's request. A sent or ambiguous delivery uploads
  again only with `again`: the provider may already hold the activity.
  */
  request(player: number, activity: number, provider: UploadProvider, again: boolean) {
    immediate(this.repositories.db, () => {
      const stored = this.activitiesRepository.fit(activity);

      if (!stored || stored.player !== player) throw new ApplicationError(404, 'Activity not found.');

      if (!stored.fit?.length || !this.uploadPayload(activity))
        throw new ApplicationError(409, 'Only a finished activity with a FIT file can be uploaded.');

      if (!this.configured(player).includes(provider))
        throw new ApplicationError(409, 'Connect this service in Integrations first.');
      const state = this.uploadsRepository.get(activity, provider)?.state;

      if (state === 'pending' || state === 'sending') return;

      if ((state === 'sent' || state === 'ambiguous') && !again)
        throw new ApplicationError(409, 'This activity may already be there. Confirm to upload it again.');

      if (state === undefined) this.uploadsRepository.insert(activity, provider);
      else this.uploadsRepository.requeue(activity, provider, z.enum(UploadState).parse(state));
      this.jobsRepository.enqueue('delivery', { activityId: activity, provider });
    });

    return this.drain();
  }

  /** Imported and older finished activities may predate completion records. Reading
  their metadata must not replay completion rewards or automatic deliveries.
  */
  private uploadPayload(activity: number) {
    const saved = this.completionRepository.get(BigInt(activity));

    if (saved) return fromBinary(ActivitySchema, saved.payload);
    const row = this.activitiesRepository.activityById(activity);

    return row?.end_date ? this.protobufRepository.decode(ActivitySchema, row) : null;
  }

  /** Failed deliveries become pending. Ambiguous ones need explicit confirmation: the
  provider may already hold the activity.
  */
  retry(player: number, ambiguous = false) {
    immediate(this.repositories.db, () => {
      for (const { activity, provider } of this.uploadsRepository.retry(player, ambiguous))
        this.jobsRepository.enqueue('delivery', { activityId: activity, provider });
    });

    return this.drain();
  }

  /** Remove a credential and cancel the pending deliveries that depended on it. */
  disconnect(player: number, file: RemovableCredentialFile) {
    immediate(this.repositories.db, () => {
      this.riderDocuments.remove(player, file);

      if (file === 'garth/oauth1_token.json') this.riderDocuments.remove(player, 'garth/oauth2_token.json');
      this.revoke(player);
    });
  }

  /** After a consent or credential change: cancel pending deliveries to providers that
  are no longer configured. A delivery job checks consent again before it sends.
  */
  revoke(player: number) {
    const allowed: string[] = this.configured(player);

    atomic(this.repositories.db, () => {
      for (const delivery of this.uploadsRepository.pendingFor(player))
        if (!allowed.includes(delivery.provider))
          this.uploadsRepository.cancel(delivery.activity_id, delivery.provider);
    });
  }

  /** Startup: no request is in flight, so an earlier send has an unknown result. */
  start() {
    const interrupted = this.uploadsRepository.interrupted();
    const paused = this.systemFlagsRepository.get(SystemFlag.UploadPause);

    if (paused !== null)
      this.runtime.world.lifecycle.log.warn('upload.paused', 'Uploads are paused; review them with uploads list', {
        reason: paused,
        waiting: this.uploadsRepository.waiting().length,
      });

    if (interrupted > 0)
      this.runtime.world.lifecycle.log.warn('upload.ambiguous', 'Interrupted uploads need a manual decision', {
        count: interrupted,
      });
  }

  /** Run ready delivery jobs now. */
  async drain() {
    await this.jobs?.drain();
  }

  registerJobs(jobs: JobsService) {
    this.jobs = jobs;
    jobs.register('delivery', {
      concurrency: 2,
      attempts: 3,
      timeoutMs: 300_000,
      run: (job) => this.deliver(job),
    });
  }

  private async deliver(job: RunningJob) {
    const activity = job.number('activityId');
    const provider = z.enum(UploadProvider).parse(job.text('provider'));
    const token = job.claim.token;

    // Check the claim, the delivery and consent, and commit sending, in one short
    // transaction. A replacement handler never sends a delivery that is sending.
    const start = immediate(this.repositories.db, () => {
      if (!job.valid()) return null;
      const delivery = this.uploadsRepository.get(activity, provider);
      const stored = this.activitiesRepository.fit(activity);
      const payload = this.uploadPayload(activity);

      if (!delivery || !stored?.fit?.length || stored.player === null || !payload) return null;

      if (delivery.state === 'sending') {
        this.uploadsRepository.abandon(activity, provider);

        return null;
      }

      if (delivery.state !== 'pending') return null;

      if (!this.configured(stored.player).includes(provider)) {
        this.uploadsRepository.cancel(activity, provider);

        return null;
      }

      this.uploadsRepository.begin(activity, provider, token);
      payload.fit = stored.fit ?? new Uint8Array();

      return { player: stored.player, payload, delivery: { ...delivery, attempt: token } };
    });

    if (!start) {
      job.commit();

      return;
    }

    // sending must survive a power loss before the provider can receive the activity.
    await this.durabilityRepository.flush();

    let outcome: 'sent' | 'failed' | 'ambiguous' = 'sent';
    let code: string | null = null;
    let failure: unknown;

    try {
      await this.send(start.player, start.payload, {
        activity,
        provider,
        token,
        delivery: start.delivery,
        signal: job.signal,
      });
    } catch (error) {
      failure = error;

      // Unreadable credentials stop the delivery before anything is sent.
      if (error instanceof UnreadableCredentialsError) {
        outcome = 'failed';
        code = 'credentials_unreadable';
      } else {
        outcome = error instanceof DeliveryRefusedError ? 'failed' : 'ambiguous';
        code = error instanceof DeliveryRefusedError ? error.code : error instanceof Error ? error.name : 'error';
      }
    }

    // The provider result is the truth even when the lease expired during the request.
    this.uploadsRepository.record(activity, provider, token, outcome, code);
    job.commit();

    const fields = { playerId: start.player, activityId: activity, provider };

    if (outcome === 'sent') this.runtime.world.lifecycle.log.info('upload.succeeded', 'Activity uploaded', fields);
    else {
      this.runtime.world.lifecycle.log.warn('upload.failed', 'Activity upload did not complete', {
        ...fields,
        outcome,
        retry: 'manual',
        error: failure instanceof Error ? failure : String(failure),
      });
      this.warn(
        outcome === 'failed'
          ? `${provider} upload failed for activity ${activity}; retry from rider home`
          : `${provider} upload result is unknown for activity ${activity}; check the provider before a retry`,
      );
    }
  }

  private send(player: number, activity: Activity, attempt: Attempt) {
    switch (attempt.provider) {
      case 'freeStrava': {
        return this.freeStrava(player, activity, this.photos(player, attempt.activity));
      }

      case 'zwift': {
        return this.zwift(player, activity, attempt);
      }

      default: {
        return this[attempt.provider](player, activity);
      }
    }
  }

  /** Ready photos and videos only: a reserved row may have no complete file yet. */
  private photos(player: number, activity: number) {
    const folder = this.runtime.profiles.folder(player);
    const paths = [];

    for (const photo of this.activitiesRepository.listActivityImage(player, activity))
      if (photo.state === 'ready') paths.push(resolve(folder, 'images', `${photo.id}.jpg`));

    for (const photo of this.activitiesRepository.listActivityMedia(player, activity))
      if (photo.state === 'ready')
        paths.push(
          resolve(folder, 'medias', `${photo.id}.${photo.content_type.includes('quicktime') ? 'mov' : 'mp4'}`),
        );

    return paths;
  }

  async strava(player: number, activity: Activity) {
    const text = this.riderDocuments.text(player, 'strava_token.txt');

    if (!text) throw new DeliveryRefusedError('strava_unauthorized');

    await this.stravaRepository.uploadPaid(
      this.stravaRepository.parseToken(text),
      activity.fit,
      this.titled(player, activity),
      (token) => this.riderDocuments.put(player, 'strava_token.txt', this.stravaRepository.serializeToken(token)),
    );
  }

  async freeStrava(player: number, activity: Activity, photos: readonly string[]) {
    const cookie = this.riderDocuments.text(player, 'strava4_session.txt')?.split(/\r?\n/, 1)[0] ?? '';

    if (!cookie) throw new DeliveryRefusedError('strava_session_missing');

    const created = await this.stravaRepository.uploadFree(
      cookie,
      activity.fitFilename,
      activity.fit,
      this.titled(player, activity),
      photos,
      undefined,
      (fresh) => this.riderDocuments.put(player, 'strava4_session.txt', fresh),
    );

    // Kept so that the route can be added to the title when the game reports it later.
    if (created !== undefined) this.activitiesRepository.setStravaActivity(activity.id, Number(created));
  }

  /** The names of the routes, read once. */
  private routes() {
    this.routeNames ??= loadRouteNames(this.runtime.assets);

    return this.routeNames;
  }

  /** The title for Strava: the game sends only the name of the workout, so the route is added when it is known. */
  private titled(player: number, activity: Activity) {
    const hash = this.recordsRepository.routeOfActivity(player, Number(activity.id));

    return titleWithRoute(activity.name, hash === null ? undefined : this.routes().get(hash));
  }

  /** The game reports the route of an activity some time after the upload. When the activity is on Strava
  through the session of the rider, add the route to its title there. Returns whether the title was changed.
  */
  async nameStravaWithRoute(player: number, activityId: number) {
    const cookie = this.riderDocuments.text(player, 'strava4_session.txt')?.split(/\r?\n/, 1)[0] ?? '';
    const row = this.activitiesRepository.activityById(activityId);

    if (!cookie || !row?.strava_activity_id || row.player_id !== BigInt(player)) return false;
    const hash = this.recordsRepository.routeOfActivity(player, activityId);
    const name = titleWithRoute(row.name ?? '', hash === null ? undefined : this.routes().get(hash));

    if (name === (row.name ?? '')) return false;

    await this.stravaRepository.renameFree(cookie, String(row.strava_activity_id), name, (fresh) =>
      this.riderDocuments.put(player, 'strava4_session.txt', fresh),
    );

    return true;
  }

  async garmin(player: number, activity: Activity) {
    if (!this.riderDocuments.has(player, 'garth/oauth1_token.json'))
      throw new DeliveryRefusedError('garmin_unauthorized');

    await this.garminRepository.uploadGarmin(
      this.garminRepository.tokenStore(this.riderDocuments, player),
      this.runtime.config.integrations.garmin.domain,
      activity.fitFilename,
      activity.fit,
    );
  }

  async runalyze(player: number, activity: Activity) {
    const token = this.riderDocuments.text(player, 'runalyze_token.txt')?.split(/\r?\n/, 1)[0] ?? '';

    if (!token) throw new DeliveryRefusedError('runalyze_unauthorized');
    const form = new FormData();
    form.set('file', this.sessionRepository.binaryBlob(activity.fit), 'file');

    await checked(
      await fetch('https://runalyze.com/api/v1/activities/uploads', {
        method: 'POST',
        headers: { token },
        body: form,
        signal: AbortSignal.timeout(60_000),
      }),
      'runalyze',
    );
  }

  async intervals(player: number, activity: Activity) {
    const credentials = this.connectionsRepository.read(player, 'intervals');

    if (!credentials) throw new DeliveryRefusedError('intervals_unauthorized');
    const [athlete, key] = credentials;

    if (!/^\d+$/.test(athlete)) throw new DeliveryRefusedError('intervals_invalid_athlete');
    const workouts = new WorkoutsService(this.runtime);
    const paired = UploadsService.pairedEvent(activity, workouts.stored(player));
    const query = new URLSearchParams({ name: activity.name });

    if (paired !== null) query.set('paired_event_id', String(paired));
    const form = new FormData();
    form.set('file', this.sessionRepository.binaryBlob(activity.fit), 'file');

    await checked(
      await fetch(`https://intervals.icu/api/v1/athlete/${athlete}/activities?${query}`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`API_KEY:${key}`).toString('base64')}`,
        },
        body: form,
        signal: AbortSignal.timeout(30_000),
      }),
      'intervals',
    );

    if (paired !== null) workouts.removeEvent(player, paired);
  }

  /** Two requests: create the official activity, then upload its FIT data. The remote
  identifier is stored before the upload, so a retry uploads to the same activity and
  never creates a second one because only the upload failed.
  */
  async zwift(player: number, activity: Activity, attempt?: Attempt) {
    const credentials = this.connectionsRepository.read(player, 'zwift');

    if (!credentials) throw new DeliveryRefusedError('zwift_unauthorized');

    let token: string;

    try {
      token = await this.zwiftRepository.officialLogin(credentials[0], credentials[1]);
    } catch {
      throw new DeliveryRefusedError('zwift_login');
    }

    const headers = this.zwiftRepository.officialHeaders(token);

    // A profile read has no remote effect: any failure before creation is a refusal.
    let official: bigint;

    try {
      const me = await checked(
        await fetch(`${officialRelay}/api/profiles/me`, {
          headers: { ...headers, Accept: 'application/x-protobuf-lite' },
          signal: AbortSignal.timeout(30_000),
        }),
        'zwift_profile',
      );

      official = fromBinary(PlayerProfileSchema, new Uint8Array(await me.arrayBuffer())).id;
    } catch (error) {
      throw error instanceof DeliveryRefusedError ? error : new DeliveryRefusedError('zwift_profile');
    }

    const full = clone(ActivitySchema, activity);
    full.playerId = official;
    const remote = attempt?.delivery.remote_id;

    if (remote) full.id = BigInt(remote);
    else {
      const draft = clone(ActivitySchema, full);
      clearField(draft, ActivitySchema.field.id);
      clearField(draft, ActivitySchema.field.fit);

      const created = await checked(
        await fetch(`${officialRelay}/api/profiles/${official}/activities`, {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/x-protobuf-lite',
            Accept: 'application/json',
          },
          body: toBinary(ActivitySchema, draft),
          signal: AbortSignal.timeout(30_000),
        }),
        'zwift_create',
      );

      full.id = BigInt(z.object({ id: z.number().int().positive() }).parse(await created.json()).id);

      if (attempt) {
        this.uploadsRepository.progress(attempt.activity, attempt.provider, attempt.token, 'created', String(full.id));
        await this.durabilityRepository.flush();
      }
    }

    await checked(
      await fetch(`${officialRelay}/api/profiles/${official}/activities/${full.id}?upload-to-strava=true`, {
        method: 'PUT',
        headers: {
          ...headers,
          'Content-Type': 'application/x-protobuf-lite',
          Accept: 'application/json',
        },
        body: toBinary(ActivitySchema, full),
        signal: AbortSignal.timeout(60_000),
      }),
      'zwift_upload',
    );
  }

  static pairedEvent(
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
}
