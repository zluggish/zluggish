import { t } from '#src/i18n/index';
import { Context, Effect, Layer } from 'effect';
import { RuntimeContext } from '#src/context';
import type { User } from '#src/repositories/accounts.repository';
import type { GarminClient, MfaState } from 'garminconnect-js';
import type { FitnessRepository } from '#src/repositories/fitness.repository';
import { officialRelay } from '#src/repositories/zwift.repository';
import type { ZwiftRepository } from '#src/repositories/zwift.repository';
import type { ProfileDownloadRepository } from '#src/repositories/profile-download.repository';
import type { StravaRepository } from '#src/repositories/strava.repository';

type GarminAttempt = {
  identity: string;
  expires: number;
  client: GarminClient;
  credentials: readonly [string, string];
} & ({ status: 'login' | 'verifying' } | { status: 'mfa'; state: MfaState });

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const repositories = context.accounts.repositories;

  const garminAttempts = new Map<string, GarminAttempt>();

  /** Session-keyed authorization: login -> mfa -> verifying -> committed/removed.
  A replacement attempt fences both old callbacks and token-file publication.
  */
  const authorizeGarminSession = Effect.fn('IntegrationsService.authorizeGarminSession')(function* (
    key: string,
    live: () => boolean,
    rider: User,
    code?: string,
  ) {
    return yield* Effect.promise(async () => {
      const identity = context.accounts.identityOf(rider);

      for (const [id, entry] of garminAttempts) {
        if (entry.expires < Date.now()) {
          garminAttempts.delete(id);
        }
      }
      let attempt: GarminAttempt;

      if (code === undefined) {
        const credentials = repositories.connectionsRepository.read(rider.player_id, 'garmin');

        if (!credentials) {
          throw new Error(t('save_credentials_first'));
        }

        if (!garminAttempts.has(key) && garminAttempts.size >= 100) {
          throw new Error(t('too_many_pending_authorizations'));
        }
        attempt = {
          status: 'login',
          identity,
          credentials,
          expires: Date.now() + 300_000,
          client: repositories.garminRepository.garminClient(null, context.config.integrations.garmin.domain),
        };
        garminAttempts.set(key, attempt);
      } else {
        const pending = garminAttempts.get(key);

        if (!pending || pending.status !== 'mfa' || pending.identity !== identity) {
          throw new Error(t('expired_authorization'));
        }
        attempt = pending;
      }

      const current = () => {
        const credentials = repositories.connectionsRepository.read(rider.player_id, 'garmin');

        return (
          garminAttempts.get(key) === attempt &&
          attempt.expires >= Date.now() &&
          live() &&
          credentials?.[0] === attempt.credentials[0] &&
          credentials?.[1] === attempt.credentials[1]
        );
      };

      try {
        if (!current()) {
          throw new Error(t('expired_authorization'));
        }

        if (attempt.status === 'mfa') {
          const state = attempt.state;
          attempt = { ...attempt, status: 'verifying' };
          garminAttempts.set(key, attempt);
          await attempt.client.resumeLogin(state, code ?? '');
        } else {
          const result = await attempt.client.login(attempt.credentials[0], attempt.credentials[1]);

          if (!current()) {
            throw new Error(t('expired_authorization'));
          }

          if (result.state === 'mfa_required') {
            if (garminAttempts.size > 100) {
              throw new Error(t('too_many_pending_authorizations'));
            }
            attempt = { ...attempt, status: 'mfa', state: result.mfaState };
            garminAttempts.set(key, attempt);

            return 'mfa';
          }
        }

        if (!current()) {
          throw new Error(t('expired_authorization'));
        }
        await repositories.garminRepository.saveAuthorization(
          repositories.garminRepository.tokenStore(repositories.riderDocuments, rider.player_id),
          attempt.client,
        );
        garminAttempts.delete(key);

        return 'authorized';
      } catch (error) {
        if (garminAttempts.get(key) === attempt) {
          garminAttempts.delete(key);
        }
        throw error;
      }
    });
  });

  const authorizeStravaSession = Effect.fn('IntegrationsService.authorizeStravaSession')(function* (
    live: () => boolean,
    rider: User,
    code: string,
  ) {
    const credentials = repositories.connectionsRepository.read(rider.player_id, 'strava');

    if (!credentials) {
      throw new Error(t('missing_strava_credentials'));
    }

    const token = yield* Effect.promise(() =>
      repositories.stravaRepository.exchangeCode(credentials[0], credentials[1], code),
    );

    const current = repositories.connectionsRepository.read(rider.player_id, 'strava');

    if (!live() || current?.[0] !== credentials[0] || current?.[1] !== credentials[1]) {
      throw new Error(t('expired_authorization'));
    }
    repositories.riderDocuments.put(
      rider.player_id,
      'strava_token.txt',
      repositories.stravaRepository.serializeToken(token),
    );
  });

  const deletePowerCurve = Effect.fn('IntegrationsService.deletePowerCurve')(function* (
    ...values: Parameters<FitnessRepository['deletePowerCurve']>
  ) {
    return repositories.fitnessRepository.deletePowerCurve(...values);
  });

  const request = Effect.fn('IntegrationsService.request')(function* (...args: Parameters<typeof fetch>) {
    return yield* Effect.promise(() => fetch(...args));
  });

  const downloadOfficialData = Effect.fn('IntegrationsService.downloadOfficialData')(function* (
    ...args: Parameters<ProfileDownloadRepository['downloadOfficialData']>
  ) {
    return yield* Effect.promise(() => repositories.profileDownloadRepository.downloadOfficialData(...args));
  });

  const authorizationUrl = Effect.fn('IntegrationsService.authorizationUrl')(function* (
    ...args: Parameters<StravaRepository['authorizationUrl']>
  ) {
    return repositories.stravaRepository.authorizationUrl(...args);
  });

  const checkSession = Effect.fn('IntegrationsService.checkSession')(function* (
    ...args: Parameters<StravaRepository['checkSession']>
  ) {
    return yield* Effect.promise(() => repositories.stravaRepository.checkSession(...args));
  });

  const officialHeaders = Effect.fn('IntegrationsService.officialHeaders')(function* (
    ...args: Parameters<ZwiftRepository['officialHeaders']>
  ) {
    return repositories.zwiftRepository.officialHeaders(...args);
  });

  const officialLogin = Effect.fn('IntegrationsService.officialLogin')(function* (
    ...args: Parameters<ZwiftRepository['officialLogin']>
  ) {
    return yield* Effect.promise(() => repositories.zwiftRepository.officialLogin(...args));
  });

  return {
    authorizeGarminSession,
    authorizeStravaSession,
    deletePowerCurve,
    request,
    downloadOfficialData,
    authorizationUrl,
    checkSession,
    officialHeaders,
    officialLogin,
    officialRelay,
  };
});

export class IntegrationsService extends Context.Service<IntegrationsService, Effect.Success<typeof make>>()(
  'zluggish/IntegrationsService',
) {
  static readonly layer = Layer.effect(IntegrationsService, make);
}
