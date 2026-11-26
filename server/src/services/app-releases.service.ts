import { RuntimeContext } from '#src/context';
import { JobType } from '#src/enum';
import type { ReleaseApp } from '#src/repositories/app-release.repository';
import { AppReleaseRepository, releaseSources } from '#src/repositories/app-release.repository';
import { AssetFiles } from '#src/repositories/files.repository';
import { JobsService } from '#src/services/jobs.service';
import { Context, Effect, Layer, Schema } from 'effect';
import { resolve } from 'node:path';

const type = JobType.AppReleaseCheck;
const day = 24 * 60 * 60 * 1000;

const mirrorSchema = Schema.Struct({
  versionName: Schema.String,
  versionCode: Schema.NullOr(Schema.Finite),
  url: Schema.String,
  publishedAt: Schema.NullOr(Schema.String),
});

const pureSchema = Schema.Struct({
  versionName: Schema.String,
  versionCode: Schema.NullOr(Schema.Finite),
  bytes: Schema.NullOr(Schema.Finite),
  filename: Schema.String,
});

const appSchema = Schema.Struct({
  apkmirror: Schema.NullOr(mirrorSchema),
  apkpure: Schema.NullOr(pureSchema),
  /** Why the last check of each source failed. The release found before it stays. */
  errors: Schema.Struct({ apkmirror: Schema.NullOr(Schema.String), apkpure: Schema.NullOr(Schema.String) }),
});

/** app-releases.json in storage: what the last check found, so a restart neither forgets nor checks again early. */
const stateSchema = Schema.Struct({
  enabled: Schema.Boolean,
  checkedAt: Schema.NullOr(Schema.String),
  apps: Schema.Struct({ zwift: appSchema, companion: appSchema }),
});

type State = typeof stateSchema.Type;
type AppState = typeof appSchema.Type;

export type AppReleasesStatus = State & { readonly checking: boolean };

const empty: AppState = { apkmirror: null, apkpure: null, errors: { apkmirror: null, apkpure: null } };

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const jobs = yield* JobsService;
  const log = context.world.lifecycle.log;
  const repository = context.accounts.repositories.jobsRepository;
  const releases = new AppReleaseRepository();
  const files = new AssetFiles();
  const statePath = resolve(context.config.storageDir, 'app-releases.json');

  let state: State | null = null;
  let checking: Promise<void> | null = null;

  async function load(): Promise<State> {
    if (state) {
      return state;
    }
    const text = await files.readAsync(statePath);

    try {
      state = text ? Schema.decodeUnknownSync(stateSchema)(JSON.parse(text.toString('utf8'))) : null;
    } catch {
      state = null;
    }
    state ??= { enabled: true, checkedAt: null, apps: { zwift: empty, companion: empty } };

    return state;
  }

  async function save(next: State) {
    state = next;
    await files.writeDurableAsync(statePath, JSON.stringify(next, null, 2), true);
  }

  async function checkApp(app: ReleaseApp, before: AppState, signal?: AbortSignal): Promise<AppState> {
    const source = releaseSources[app];
    const [mirror, pure] = await Promise.allSettled([
      releases.apkmirror(source.feed, signal),
      releases.apkpure(source.packageName, signal),
    ]);
    const result: AppState = {
      apkmirror: mirror.status === 'fulfilled' ? mirror.value : before.apkmirror,
      apkpure:
        pure.status === 'fulfilled'
          ? pure.value && {
              versionName: pure.value.versionName,
              versionCode: pure.value.versionCode,
              bytes: pure.value.bytes,
              filename: pure.value.filename,
            }
          : before.apkpure,
      errors: {
        apkmirror: mirror.status === 'rejected' ? reason(mirror.reason) : null,
        apkpure: pure.status === 'rejected' ? reason(pure.reason) : null,
      },
    };

    log.info('releases.checked', 'Checked for new releases', {
      app,
      apkmirror: result.apkmirror?.versionName ?? null,
      apkpure: result.apkpure?.versionName ?? null,
    });

    for (const [name, error] of Object.entries(result.errors)) {
      if (error) {
        log.warn('releases.source_failed', 'Could not check a release source', { app, source: name, error });
      }
    }

    return result;
  }

  /** Check both apps once. Checks that overlap share one run. */
  function check(signal?: AbortSignal) {
    checking ??= (async () => {
      try {
        const before = await load();
        const [zwift, companion] = await Promise.all([
          checkApp('zwift', before.apps.zwift, signal),
          checkApp('companion', before.apps.companion, signal),
        ]);
        await save({ ...(await load()), checkedAt: new Date().toISOString(), apps: { zwift, companion } });
      } finally {
        checking = null;
      }
    })();

    return checking;
  }

  /** Queue the next check a day after the last one, or now when there has been none. */
  async function schedule() {
    const current = await load();

    if (!current.enabled) {
      return;
    }
    const now = repository.now();
    const checkAt = Math.max(now, (current.checkedAt ? Date.parse(current.checkedAt) : 0) + day);
    repository.enqueueOnce(type, { checkAt }, checkAt - now);
  }

  async function status(): Promise<AppReleasesStatus> {
    return { ...(await load()), checking: checking !== null };
  }

  yield* jobs.register(type, {
    concurrency: 1,
    // A failed source is recorded and tried again with the next daily check, so the job itself never retries.
    attempts: 1,
    timeoutMs: 5 * 60 * 1000,
    run: (job) =>
      Effect.promise(async () => {
        const current = await load();

        if (current.enabled) {
          await check(job.signal);
        }
        await schedule();
      }),
  });

  return {
    schedule: Effect.fn('AppReleasesService.schedule')(function* () {
      yield* Effect.promise(schedule);
    }),
    status: Effect.fn('AppReleasesService.status')(function* () {
      return yield* Effect.promise(status);
    }),
    /** Check now, as the administrator asked. The daily check then counts from here. */
    check: Effect.fn('AppReleasesService.check')(function* () {
      yield* Effect.promise(async () => {
        await check();
        await schedule();
      });

      return yield* Effect.promise(status);
    }),
    setEnabled: Effect.fn('AppReleasesService.setEnabled')(function* (enabled: boolean) {
      yield* Effect.promise(async () => {
        await save({ ...(await load()), enabled });
        if (enabled) {
          log.info('releases.enabled', 'Turned on daily release checks');
          await schedule();
        } else {
          log.info('releases.disabled', 'Turned off daily release checks');
        }
      });

      return yield* Effect.promise(status);
    }),
  };
});

export class AppReleasesService extends Context.Service<AppReleasesService, Effect.Success<typeof make>>()(
  'zluggish/AppReleasesService',
) {
  static readonly layer = Layer.effect(AppReleasesService, make);
}
