import type { Repositories } from '#src/repositories';

export type BaseServiceDeps = Pick<Repositories, keyof Repositories>;

export abstract class BaseService {
  constructor(readonly repositories: BaseServiceDeps) {}

  protected get loggingRepository() {
    return this.repositories.loggingRepository;
  }

  protected get accountsRepository() {
    return this.repositories.accountsRepository;
  }

  protected get activitiesRepository() {
    return this.repositories.activitiesRepository;
  }

  protected get connectionsRepository() {
    return this.repositories.connectionsRepository;
  }

  protected get eventsRepository() {
    return this.repositories.eventsRepository;
  }

  protected get fitnessRepository() {
    return this.repositories.fitnessRepository;
  }

  protected get goalRepository() {
    return this.repositories.goalRepository;
  }

  protected get protobufRepository() {
    return this.repositories.protobufRepository;
  }

  protected get recordsRepository() {
    return this.repositories.recordsRepository;
  }

  protected get socialRepository() {
    return this.repositories.socialRepository;
  }

  protected get storageRepository() {
    return this.repositories.storageRepository;
  }

  protected get uploadsRepository() {
    return this.repositories.uploadsRepository;
  }

  protected get completionRepository() {
    return this.repositories.completionRepository;
  }

  protected get cryptoRepository() {
    return this.repositories.cryptoRepository;
  }

  protected get filesRepository() {
    return this.repositories.filesRepository;
  }

  protected get lockRepository() {
    return this.repositories.lockRepository;
  }

  protected get profileJsonRepository() {
    return this.repositories.profileJsonRepository;
  }

  protected get profileDownloadRepository() {
    return this.repositories.profileDownloadRepository;
  }

  protected get stravaRepository() {
    return this.repositories.stravaRepository;
  }

  protected get garminRepository() {
    return this.repositories.garminRepository;
  }

  protected get streakRepository() {
    return this.repositories.streakRepository;
  }

  protected get eventCatalogRepository() {
    return this.repositories.eventCatalogRepository;
  }

  protected get riderRepository() {
    return this.repositories.riderRepository;
  }

  protected get sessionRepository() {
    return this.repositories.sessionRepository;
  }

  protected get zwiftRepository() {
    return this.repositories.zwiftRepository;
  }

  protected get discordRepository() {
    return this.repositories.discordRepository;
  }

  protected get profileRepository() {
    return this.repositories.profileRepository;
  }

  protected get settingsRepository() {
    return this.repositories.settingsRepository;
  }
}
