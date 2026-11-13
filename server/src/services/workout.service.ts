import type { RepositoryContext } from '#src/context';
import { syncWorkoutsAutomatically } from '#src/repositories/automatic-workout.repository';
import type { Workouts } from '#src/repositories/workout.repository';

export class WorkoutsService {
  constructor(
    private readonly repository: Workouts,
    private readonly context: RepositoryContext,
  ) {}
  provider(...args: Parameters<Workouts['provider']>) {
    return this.repository.provider(...args);
  }
  entries(...args: Parameters<Workouts['entries']>) {
    return this.repository.entries(...args);
  }
  metadataFile(...args: Parameters<Workouts['metadataFile']>) {
    return this.repository.metadataFile(...args);
  }
  stored(...args: Parameters<Workouts['stored']>) {
    return this.repository.stored(...args);
  }
  removeEvent(...args: Parameters<Workouts['removeEvent']>) {
    return this.repository.removeEvent(...args);
  }
  list(...args: Parameters<Workouts['list']>) {
    return this.repository.list(...args);
  }
  file(...args: Parameters<Workouts['file']>) {
    return this.repository.file(...args);
  }
  sync(...args: Parameters<Workouts['sync']>) {
    return this.repository.sync(...args);
  }
  bridge(...args: Parameters<Workouts['bridge']>) {
    return this.repository.bridge(...args);
  }

  syncWorkoutsAutomatically(id: number, android = false) {
    return syncWorkoutsAutomatically(this.context, id, android);
  }
}
