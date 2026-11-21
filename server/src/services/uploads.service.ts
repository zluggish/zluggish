import { isIntervalsAthleteId } from '#src/dtos/intervals.dto';
import { RuntimeContext } from '#src/context';
import { UploadProvider, UploadState } from '#src/enum';
import type { RemovableCredentialFile, JobType } from '#src/enum';
import { atomic, immediate } from '#src/db/transaction';
import { ApplicationError, DeliveryRefusedError, refused, UnreadableCredentialsError } from '#src/errors';
import type { Activity } from '#src/protocol/generated/activity_pb';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import { SystemFlag } from '#src/repositories/system-flag.repository';
import type { Delivery } from '#src/repositories/uploads.repository';
import { officialRelay } from '#src/repositories/zwift.repository';
import type { RunningJob } from '#src/repositories/jobs.repository';
import { JobsService } from '#src/services/jobs.service';
import type { JobHandler } from '#src/services/jobs.service';
import { SettingsService } from '#src/services/settings.service';
import type { StoredEntry } from '#src/dtos/workout.dto';
import { WorkoutsService } from '#src/services/workout.service';
import { parseDeviceIdentity, patchDeviceIdentity } from '#src/world/fit-device';
import { clearField, clone, fromBinary, toBinary } from '@bufbuild/protobuf';
import { resolve } from 'node:path';
import { Context, Effect, Layer, Schema } from 'effect';

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
  if (response.ok) {
    return response;
  }
  await response.body?.cancel();

  if (refused(response.status)) {
    throw new DeliveryRefusedError({ code: `${code}_${response.status}` });
  }
  throw new Error(`${code}_${response.status}`);
}

function pairedEvent(
  activity: Pick<Activity, 'name' | 'startDate' | 'date'>,
  stored: { collection: boolean; entries: Array<StoredEntry> },
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

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const repositories = context.accounts.repositories;
  const workoutsService = yield* WorkoutsService;
  const jobs = yield* JobsService;

  function configured(player: number) {
    const settings = SettingsService.resolveRiderSettings(context.config.riderDefaults, context.settings.read(player));

    const providers: Array<UploadProvider> = [];

    const has = (name: Parameters<typeof repositories.riderDocuments.has>[1]) =>
      repositories.riderDocuments.has(player, name);

    if (has(settings.uploads.strava.method === 'free' ? 'strava4_session.txt' : 'strava_token.txt')) {
      providers.push(settings.uploads.strava.method === 'free' ? 'freeStrava' : 'strava');
    }

    if (has('garth/oauth1_token.json')) {
      providers.push('garmin');
    }

    if (has('runalyze_token.txt')) {
      providers.push('runalyze');
    }

    if (repositories.connectionsRepository.has(player, 'intervals')) {
      providers.push('intervals');
    }

    if (settings.uploads.zwift.enabled && repositories.connectionsRepository.has(player, 'zwift')) {
      providers.push('zwift');
    }

    return providers;
  }

  function status(player: number) {
    return repositories.uploadsRepository.status(player).map((row) =>
      Schema.decodeUnknownSync(
        Schema.Struct({
          activity_id: Schema.Finite,
          provider: Schema.String,
          state: Schema.String,
          last_error: Schema.NullOr(Schema.String),
        }),
      )(row),
    );
  }

  function forActivity(player: number, activity: number) {
    return configured(player).map((provider) => {
      const delivery = repositories.uploadsRepository.get(activity, provider);

      return { provider, state: delivery?.state ?? null, error: delivery?.last_error ?? null };
    });
  }

  /** Upload a finished activity on the rider's request. A sent or ambiguous delivery uploads
  again only with `again`: the provider may already hold the activity.
  */
  function request(player: number, activity: number, provider: UploadProvider, again: boolean) {
    immediate(repositories.db, () => {
      const stored = repositories.activitiesRepository.fit(activity);

      if (!stored || stored.player !== player) {
        throw new ApplicationError({ status: 404, message: 'Activity not found.' });
      }

      if (!stored.fit?.length || !uploadPayload(activity)) {
        throw new ApplicationError({
          status: 409,
          message: 'Only a finished activity with a FIT file can be uploaded.',
        });
      }

      if (!configured(player).includes(provider)) {
        throw new ApplicationError({ status: 409, message: 'Connect this service in Integrations first.' });
      }
      const state = repositories.uploadsRepository.get(activity, provider)?.state;

      if (state === 'pending' || state === 'sending') {
        return;
      }

      if ((state === 'sent' || state === 'ambiguous') && !again) {
        throw new ApplicationError({
          status: 409,
          message: 'This activity may already be there. Confirm to upload it again.',
        });
      }

      if (state === undefined) {
        repositories.uploadsRepository.insert(activity, provider);
      } else {
        repositories.uploadsRepository.requeue(
          activity,
          provider,
          Schema.decodeUnknownSync(Schema.Enum(UploadState))(state),
        );
      }
      repositories.jobsRepository.enqueue('delivery', { activityId: activity, provider });
    });

    return drain();
  }

  /** Imported and older finished activities may predate completion records. Reading
  their metadata must not replay completion rewards or automatic deliveries.
  */
  function uploadPayload(activity: number) {
    const saved = repositories.completionRepository.get(BigInt(activity));

    if (saved) {
      return fromBinary(ActivitySchema, saved.payload);
    }
    const row = repositories.activitiesRepository.activityById(activity);

    return row?.end_date ? repositories.protobufRepository.decode(ActivitySchema, row) : null;
  }

  /** Failed deliveries become pending. Ambiguous ones need explicit confirmation: the
  provider may already hold the activity.
  */
  function retry(player: number, ambiguous = false) {
    immediate(repositories.db, () => {
      for (const { activity, provider } of repositories.uploadsRepository.retry(player, ambiguous)) {
        repositories.jobsRepository.enqueue('delivery', { activityId: activity, provider });
      }
    });

    return drain();
  }

  /** Remove a credential and cancel the pending deliveries that depended on it. */
  function disconnect(player: number, file: RemovableCredentialFile) {
    immediate(repositories.db, () => {
      repositories.riderDocuments.remove(player, file);

      if (file === 'garth/oauth1_token.json') {
        repositories.riderDocuments.remove(player, 'garth/oauth2_token.json');
      }
      revoke(player);
    });
  }

  /** After a consent or credential change: cancel pending deliveries to providers that
  are no longer configured. A delivery job checks consent again before it sends.
  */
  function revoke(player: number) {
    const allowed: Array<string> = configured(player);

    atomic(repositories.db, () => {
      for (const delivery of repositories.uploadsRepository.pendingFor(player)) {
        if (!allowed.includes(delivery.provider)) {
          repositories.uploadsRepository.cancel(delivery.activity_id, delivery.provider);
        }
      }
    });
  }

  /** Startup: no request is in flight, so an earlier send has an unknown result. */
  function startNow() {
    const interrupted = repositories.uploadsRepository.interrupted();
    const paused = repositories.systemFlagsRepository.get(SystemFlag.UploadPause);

    if (paused !== null) {
      context.world.lifecycle.log.warn('upload.paused', 'Uploads are paused; review them with uploads list', {
        reason: paused,
        waiting: repositories.uploadsRepository.waiting().length,
      });
    }

    if (interrupted > 0) {
      context.world.lifecycle.log.warn('upload.ambiguous', 'Interrupted uploads need a manual decision', {
        count: interrupted,
      });
    }
  }

  async function drain() {
    await Effect.runPromise(jobs.drain());
  }

  function registerJobs(runner: JobsService['Service']) {
    const register = (type: JobType, handler: Omit<JobHandler, 'run'> & { run: (job: RunningJob) => Promise<void> }) =>
      Effect.runSync(runner.register(type, { ...handler, run: (job) => Effect.promise(() => handler.run(job)) }));

    register('delivery', {
      concurrency: 2,
      attempts: 3,
      timeoutMs: 300_000,
      run: (job) => deliver(job),
    });
  }

  async function deliver(job: RunningJob) {
    const activity = job.number('activityId');
    const provider = Schema.decodeUnknownSync(Schema.Enum(UploadProvider))(job.text('provider'));
    const token = job.claim.token;

    // Check the claim, the delivery and consent, and commit sending, in one short
    // transaction. A replacement handler never sends a delivery that is sending.
    const start = immediate(repositories.db, () => {
      if (!job.valid()) {
        return null;
      }
      const delivery = repositories.uploadsRepository.get(activity, provider);
      const stored = repositories.activitiesRepository.fit(activity);
      const payload = uploadPayload(activity);

      if (!delivery || !stored?.fit?.length || stored.player === null || !payload) {
        return null;
      }

      if (delivery.state === 'sending') {
        repositories.uploadsRepository.abandon(activity, provider);

        return null;
      }

      if (delivery.state !== 'pending') {
        return null;
      }

      if (!configured(stored.player).includes(provider)) {
        repositories.uploadsRepository.cancel(activity, provider);

        return null;
      }

      repositories.uploadsRepository.begin(activity, provider, token);
      payload.fit = stored.fit ?? new Uint8Array();

      return { player: stored.player, payload, delivery: { ...delivery, attempt: token } };
    });

    if (!start) {
      job.commit();

      return;
    }

    // sending must survive a power loss before the provider can receive the activity.
    await repositories.durabilityRepository.flush();

    let outcome: 'sent' | 'failed' | 'ambiguous' = 'sent';
    let code: string | null = null;
    let failure: unknown;

    try {
      await send(start.player, start.payload, {
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
    repositories.uploadsRepository.record(activity, provider, token, outcome, code);
    job.commit();

    const fields = { playerId: start.player, activityId: activity, provider };

    if (outcome === 'sent') {
      context.world.lifecycle.log.info('upload.succeeded', 'Activity uploaded', fields);
    } else {
      context.world.lifecycle.log.warn('upload.failed', 'Activity upload did not complete', {
        ...fields,
        outcome,
        retry: 'manual',
        error: failure instanceof Error ? failure : String(failure),
      });
    }
  }

  function send(player: number, activity: Activity, attempt: Attempt) {
    switch (attempt.provider) {
      case 'freeStrava': {
        return freeStrava(player, activity, photosNow(player, attempt.activity));
      }

      case 'zwift': {
        return zwift(player, activity, attempt);
      }

      default: {
        return ({ strava, garmin, runalyze, intervals } as const)[attempt.provider](player, activity);
      }
    }
  }

  /** Ready photos and videos only: a reserved row may have no complete file yet. */
  function photosNow(player: number, activity: number) {
    const folder = context.profiles.folder(player);
    const paths = [];

    for (const photo of repositories.activitiesRepository.listActivityImage(player, activity)) {
      if (photo.state === 'ready') {
        paths.push(resolve(folder, 'images', `${photo.id}.jpg`));
      }
    }

    for (const photo of repositories.activitiesRepository.listActivityMedia(player, activity)) {
      if (photo.state === 'ready') {
        paths.push(
          resolve(folder, 'medias', `${photo.id}.${photo.content_type.includes('quicktime') ? 'mov' : 'mp4'}`),
        );
      }
    }

    return paths;
  }

  /** Whether this rider let Garmin Connect receive the FIT file as recorded on their Edge. */
  function sendsGarminDevice(player: number): boolean {
    const settings = SettingsService.resolveRiderSettings(context.config.riderDefaults, context.settings.read(player));

    return settings.uploads.garmin.device.enabled;
  }

  /** The device is opt-in: with `uploads.garmin.device.enabled` off, Garmin gets the file of the game, and the
  chosen model and serial number are kept so they survive turning the setting back on. */
  function forGarmin(player: number, fit: Uint8Array) {
    if (!sendsGarminDevice(player)) {
      return fit;
    }

    const identity = parseDeviceIdentity(repositories.riderDocuments.text(player, 'garmin_device.txt') ?? '');

    if (!identity) {
      return fit;
    }
    const result = patchDeviceIdentity(fit, identity);

    if (result.patched === 0) {
      context.world.lifecycle.log.warn(
        'garmin.device',
        'The FIT file could not be given the Garmin device; it is sent as it is',
      );
    }

    return result.patched > 0 ? result.fit : fit;
  }

  async function strava(player: number, activity: Activity) {
    const text = repositories.riderDocuments.text(player, 'strava_token.txt');

    if (!text) {
      throw new DeliveryRefusedError({ code: 'strava_unauthorized' });
    }

    await repositories.stravaRepository.uploadPaid(
      repositories.stravaRepository.parseToken(text),
      activity.fit,
      activity.name,
      (token) =>
        repositories.riderDocuments.put(
          player,
          'strava_token.txt',
          repositories.stravaRepository.serializeToken(token),
        ),
    );
  }

  async function freeStrava(player: number, activity: Activity, photos: ReadonlyArray<string>) {
    const cookie = repositories.riderDocuments.text(player, 'strava4_session.txt')?.split(/\r?\n/, 1)[0] ?? '';

    if (!cookie) {
      throw new DeliveryRefusedError({ code: 'strava_session_missing' });
    }
    await repositories.stravaRepository.uploadFree(
      cookie,
      activity.fitFilename,
      activity.fit,
      activity.name,
      photos,
      undefined,
      (fresh) => repositories.riderDocuments.put(player, 'strava4_session.txt', fresh),
    );
  }

  async function garmin(player: number, activity: Activity) {
    if (!repositories.riderDocuments.has(player, 'garth/oauth1_token.json')) {
      throw new DeliveryRefusedError({ code: 'garmin_unauthorized' });
    }

    await repositories.garminRepository.uploadGarmin(
      repositories.garminRepository.tokenStore(repositories.riderDocuments, player),
      context.config.integrations.garmin.domain,
      activity.fitFilename,
      forGarmin(player, activity.fit),
    );
  }

  async function runalyze(player: number, activity: Activity) {
    const token = repositories.riderDocuments.text(player, 'runalyze_token.txt')?.split(/\r?\n/, 1)[0] ?? '';

    if (!token) {
      throw new DeliveryRefusedError({ code: 'runalyze_unauthorized' });
    }
    const form = new FormData();
    form.set('file', repositories.sessionRepository.binaryBlob(activity.fit), 'file');

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

  async function intervals(player: number, activity: Activity) {
    const credentials = repositories.connectionsRepository.read(player, 'intervals');

    if (!credentials) {
      throw new DeliveryRefusedError({ code: 'intervals_unauthorized' });
    }
    const [athlete, key] = credentials;

    if (!isIntervalsAthleteId(athlete)) {
      throw new DeliveryRefusedError({ code: 'intervals_invalid_athlete' });
    }
    const workouts = workoutsService;
    const paired = pairedEvent(activity, Effect.runSync(workouts.stored(player)));
    const query = new URLSearchParams({ name: activity.name });

    if (paired !== null) {
      query.set('paired_event_id', String(paired));
    }
    const form = new FormData();
    form.set('file', repositories.sessionRepository.binaryBlob(activity.fit), 'file');

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

    if (paired !== null) {
      Effect.runSync(workouts.removeEvent(player, paired));
    }
  }

  /** Two requests: create the official activity, then upload its FIT data. The remote
  identifier is stored before the upload, so a retry uploads to the same activity and
  never creates a second one because only the upload failed.
  */
  async function zwift(player: number, activity: Activity, attempt?: Attempt) {
    const credentials = repositories.connectionsRepository.read(player, 'zwift');

    if (!credentials) {
      throw new DeliveryRefusedError({ code: 'zwift_unauthorized' });
    }

    let token: string;

    try {
      token = await repositories.zwiftRepository.officialLogin(credentials[0], credentials[1]);
    } catch {
      throw new DeliveryRefusedError({ code: 'zwift_login' });
    }

    const headers = repositories.zwiftRepository.officialHeaders(token);

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
      throw error instanceof DeliveryRefusedError ? error : new DeliveryRefusedError({ code: 'zwift_profile' });
    }

    const full = clone(ActivitySchema, activity);
    full.playerId = official;
    const remote = attempt?.delivery.remote_id;

    if (remote) {
      full.id = BigInt(remote);
    } else {
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

      full.id = BigInt(
        Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Int.check(Schema.isGreaterThan(0)) }))(await created.json())
          .id,
      );

      if (attempt) {
        repositories.uploadsRepository.progress(
          attempt.activity,
          attempt.provider,
          attempt.token,
          'created',
          String(full.id),
        );
        await repositories.durabilityRepository.flush();
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

  registerJobs(jobs);

  return {
    /** Deliver through another job runner too. For tests. */
    registerJobs: Effect.fn('UploadsService.registerJobs')(function* (runner: JobsService['Service']) {
      registerJobs(runner);
    }),
    configured: Effect.fn('UploadsService.configured')(function* (player: number) {
      return configured(player);
    }),

    status: Effect.fn('UploadsService.status')(function* (player: number) {
      return status(player);
    }),
    forActivity: Effect.fn('UploadsService.forActivity')(function* (player: number, activity: number) {
      return forActivity(player, activity);
    }),
    /** Upload a finished activity on the rider's request. A sent or ambiguous delivery uploads
  again only with `again`: the provider may already hold the activity.
  */
    request: Effect.fn('UploadsService.request')(function* (
      player: number,
      activity: number,
      provider: UploadProvider,
      again: boolean,
    ) {
      return yield* Effect.promise(() => request(player, activity, provider, again));
    }),
    /** Failed deliveries become pending. Ambiguous ones need explicit confirmation: the
  provider may already hold the activity.
  */
    retry: Effect.fn('UploadsService.retry')(function* (player: number, ambiguous: boolean = false) {
      return yield* Effect.promise(() => retry(player, ambiguous));
    }),
    /** Remove a credential and cancel the pending deliveries that depended on it. */
    disconnect: Effect.fn('UploadsService.disconnect')(function* (player: number, file: RemovableCredentialFile) {
      return disconnect(player, file);
    }),
    /** After a consent or credential change: cancel pending deliveries to providers that
  are no longer configured. A delivery job checks consent again before it sends.
  */
    revoke: Effect.fn('UploadsService.revoke')(function* (player: number) {
      return revoke(player);
    }),
    /** Startup: no request is in flight, so an earlier send has an unknown result. */
    start: Effect.fn('UploadsService.start')(function* () {
      return startNow();
    }),
    drain: Effect.fn('UploadsService.drain')(function* () {
      return yield* Effect.promise(() => drain());
    }),

    strava: Effect.fn('UploadsService.strava')(function* (player: number, activity: Activity) {
      return yield* Effect.promise(() => strava(player, activity));
    }),

    freeStrava: Effect.fn('UploadsService.freeStrava')(function* (
      player: number,
      activity: Activity,
      photos: ReadonlyArray<string>,
    ) {
      return yield* Effect.promise(() => freeStrava(player, activity, photos));
    }),

    garmin: Effect.fn('UploadsService.garmin')(function* (player: number, activity: Activity) {
      return yield* Effect.promise(() => garmin(player, activity));
    }),

    runalyze: Effect.fn('UploadsService.runalyze')(function* (player: number, activity: Activity) {
      return yield* Effect.promise(() => runalyze(player, activity));
    }),

    intervals: Effect.fn('UploadsService.intervals')(function* (player: number, activity: Activity) {
      return yield* Effect.promise(() => intervals(player, activity));
    }),
    /** Two requests: create the official activity, then upload its FIT data. The remote
  identifier is stored before the upload, so a retry uploads to the same activity and
  never creates a second one because only the upload failed.
  */
    zwift: Effect.fn('UploadsService.zwift')(function* (player: number, activity: Activity, attempt?: Attempt) {
      return yield* Effect.promise(() => zwift(player, activity, attempt));
    }),
  };
});

/** Only one planned workout for the activity's day, or an exact unique title, pairs. */
export class UploadsService extends Context.Service<UploadsService, Effect.Success<typeof make>>()(
  'zluggish/UploadsService',
) {
  static readonly layer = Layer.effect(UploadsService, make);

  static readonly pairedEvent = pairedEvent;
}
