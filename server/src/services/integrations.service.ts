import type { Rider } from '#src/repositories/accounts.repository';
import type { BrowserSession } from '#src/services/browser-session.service';
import type { GarminClient, MfaState } from 'garminconnect-js';
import { resolve } from 'node:path';
import type { RepositoryContext } from '#src/context';
import type { FitnessRepository } from '#src/repositories/fitness.repository';
import { officialRelay } from '#src/repositories/zwift.repository';
import { BaseService } from '#src/services/base.service';

type GarminAttempt = {
  identity: string;
  expires: number;
  client: GarminClient;
  credentials: readonly [string, string];
} & ({ status: 'login' | 'verifying' } | { status: 'mfa'; state: MfaState });

export class IntegrationsService extends BaseService {
  private readonly garminAttempts = new Map<string, GarminAttempt>();

  constructor(readonly context: RepositoryContext) {
    super(context.accounts.repositories);
  }
  /** Browser-keyed authorization: login -> mfa -> verifying -> committed/removed.
  A replacement attempt fences both old callbacks and token-file publication.
  */
  async authorizeGarmin(key: string, browser: BrowserSession, rider: Rider, code?: string) {
    const identity = this.context.accounts.identityOf(rider);
    const folder = resolve(this.context.profiles.folder(rider.player_id), 'garth');

    for (const [id, entry] of this.garminAttempts) if (entry.expires < Date.now()) this.garminAttempts.delete(id);
    let attempt: GarminAttempt;

    if (code === undefined) {
      const credentials = this.connectionsRepository.read(rider.player_id, 'garmin');

      if (!credentials) throw new Error('Save credentials first');

      if (!this.garminAttempts.has(key) && this.garminAttempts.size >= 100)
        throw new Error('Too many pending authorizations');
      attempt = {
        status: 'login',
        identity,
        credentials,
        expires: Date.now() + 300_000,
        client: this.garminRepository.garminClient(folder, this.context.config.integrations.garmin.domain, false),
      };
      this.garminAttempts.set(key, attempt);
    } else {
      const pending = this.garminAttempts.get(key);

      if (!pending || pending.status !== 'mfa' || pending.identity !== identity)
        throw new Error('Expired authorization');
      attempt = pending;
    }

    const current = () => {
      const credentials = this.connectionsRepository.read(rider.player_id, 'garmin');

      return (
        this.garminAttempts.get(key) === attempt &&
        attempt.expires >= Date.now() &&
        this.context.sessions.current(key, browser, identity) &&
        credentials?.[0] === attempt.credentials[0] &&
        credentials?.[1] === attempt.credentials[1]
      );
    };

    try {
      if (!current()) throw new Error('Expired authorization');

      if (attempt.status === 'mfa') {
        const state = attempt.state;
        attempt = { ...attempt, status: 'verifying' };
        this.garminAttempts.set(key, attempt);
        await attempt.client.resumeLogin(state, code ?? '');
      } else {
        const result = await attempt.client.login(attempt.credentials[0], attempt.credentials[1]);

        if (!current()) throw new Error('Expired authorization');

        if (result.state === 'mfa_required') {
          if (this.garminAttempts.size > 100) throw new Error('Too many pending authorizations');
          attempt = { ...attempt, status: 'mfa', state: result.mfaState };
          this.garminAttempts.set(key, attempt);

          return 'mfa';
        }
      }

      if (!current()) throw new Error('Expired authorization');
      this.garminRepository.saveAuthorization(folder, attempt.client);
      this.garminAttempts.delete(key);

      return 'authorized';
    } catch (error) {
      if (this.garminAttempts.get(key) === attempt) this.garminAttempts.delete(key);
      throw error;
    }
  }

  async authorizeStrava(key: string, browser: BrowserSession, rider: Rider, code: string) {
    const credentials = this.connectionsRepository.read(rider.player_id, 'strava');

    if (!credentials) throw new Error('Missing Strava credentials');
    const token = await this.stravaRepository.exchangeCode(credentials[0], credentials[1], code);
    const current = this.connectionsRepository.read(rider.player_id, 'strava');

    if (
      !this.context.sessions.current(key, browser, this.context.accounts.identityOf(rider)) ||
      current?.[0] !== credentials[0] ||
      current?.[1] !== credentials[1]
    )
      throw new Error('Expired authorization');
    this.stravaRepository.writeToken(resolve(this.context.profiles.folder(rider.player_id), 'strava_token.txt'), token);
  }

  deletePowerCurve(...values: Parameters<FitnessRepository['deletePowerCurve']>) {
    return this.fitnessRepository.deletePowerCurve(...values);
  }

  request(...args: Parameters<typeof fetch>) {
    return fetch(...args);
  }

  downloadOfficialData(...args: Parameters<typeof this.profileDownloadRepository.downloadOfficialData>) {
    return this.profileDownloadRepository.downloadOfficialData(...args);
  }

  authorizationUrl(...args: Parameters<typeof this.stravaRepository.authorizationUrl>) {
    return this.stravaRepository.authorizationUrl(...args);
  }

  checkSession(...args: Parameters<typeof this.stravaRepository.checkSession>) {
    return this.stravaRepository.checkSession(...args);
  }

  officialHeaders(...args: Parameters<typeof this.zwiftRepository.officialHeaders>) {
    return this.zwiftRepository.officialHeaders(...args);
  }

  officialLogin(...args: Parameters<typeof this.zwiftRepository.officialLogin>) {
    return this.zwiftRepository.officialLogin(...args);
  }

  readonly officialRelay = officialRelay;
}
