import type { ActivityUploads } from '#src/repositories/uploads.repository';

export class UploadsService {
  constructor(private readonly repository: ActivityUploads) {}
  run(...args: Parameters<ActivityUploads['run']>) {
    return this.repository.run(...args);
  }
  strava(...args: Parameters<ActivityUploads['strava']>) {
    return this.repository.strava(...args);
  }
  freeStrava(...args: Parameters<ActivityUploads['freeStrava']>) {
    return this.repository.freeStrava(...args);
  }
  garmin(...args: Parameters<ActivityUploads['garmin']>) {
    return this.repository.garmin(...args);
  }
  runalyze(...args: Parameters<ActivityUploads['runalyze']>) {
    return this.repository.runalyze(...args);
  }
  intervals(...args: Parameters<ActivityUploads['intervals']>) {
    return this.repository.intervals(...args);
  }
  zwift(...args: Parameters<ActivityUploads['zwift']>) {
    return this.repository.zwift(...args);
  }
}
