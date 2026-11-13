import type { RepositoryContext } from '#src/context';
import type { FitnessRepository } from '#src/repositories/fitness.repository';
import { officialRelay } from '#src/repositories/zwift.repository';
import { BaseService } from '#src/services/base.service';

export class IntegrationsService extends BaseService {
  constructor(context: RepositoryContext) {
    super(context.accounts.repositories);
  }
  deletePowerCurve(...values: Parameters<FitnessRepository['deletePowerCurve']>) {
    return this.fitnessRepository.deletePowerCurve(...values);
  }

  request(...args: Parameters<typeof fetch>) {
    return fetch(...args);
  }

  garminClient(...args: Parameters<typeof this.garminRepository.garminClient>) {
    return this.garminRepository.garminClient(...args);
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

  exchangeCode(...args: Parameters<typeof this.stravaRepository.exchangeCode>) {
    return this.stravaRepository.exchangeCode(...args);
  }

  writeToken(...args: Parameters<typeof this.stravaRepository.writeToken>) {
    return this.stravaRepository.writeToken(...args);
  }

  officialHeaders(...args: Parameters<typeof this.zwiftRepository.officialHeaders>) {
    return this.zwiftRepository.officialHeaders(...args);
  }

  officialLogin(...args: Parameters<typeof this.zwiftRepository.officialLogin>) {
    return this.zwiftRepository.officialLogin(...args);
  }

  readonly officialRelay = officialRelay;
}
