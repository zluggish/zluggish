import { garminClient } from '#src/repositories/garmin.repository';
import type { FitnessRepository } from '#src/repositories/fitness.repository';
import { downloadOfficialData } from '#src/repositories/profile-download.repository';
import { authorizationUrl, checkSession, exchangeCode, writeToken } from '#src/repositories/strava.repository';
import { officialHeaders, officialLogin, officialRelay } from '#src/repositories/zwift.repository';

export class IntegrationsService {
  constructor(private readonly repository: FitnessRepository) {}
  deletePowerCurve(...values: Parameters<FitnessRepository['deletePowerCurve']>) {
    return this.repository.deletePowerCurve(...values);
  }

  request(...args: Parameters<typeof fetch>) {
    return fetch(...args);
  }

  garminClient(...args: Parameters<typeof garminClient>) {
    return garminClient(...args);
  }

  downloadOfficialData(...args: Parameters<typeof downloadOfficialData>) {
    return downloadOfficialData(...args);
  }

  authorizationUrl(...args: Parameters<typeof authorizationUrl>) {
    return authorizationUrl(...args);
  }

  checkSession(...args: Parameters<typeof checkSession>) {
    return checkSession(...args);
  }

  exchangeCode(...args: Parameters<typeof exchangeCode>) {
    return exchangeCode(...args);
  }

  writeToken(...args: Parameters<typeof writeToken>) {
    return writeToken(...args);
  }

  officialHeaders(...args: Parameters<typeof officialHeaders>) {
    return officialHeaders(...args);
  }

  officialLogin(...args: Parameters<typeof officialLogin>) {
    return officialLogin(...args);
  }

  readonly officialRelay = officialRelay;
}
