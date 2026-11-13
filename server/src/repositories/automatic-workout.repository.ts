import type { RepositoryContext as Runtime } from '#src/context';
import { Workouts } from '#src/repositories/workout.repository';

const pending = new WeakMap<Runtime, Map<string, Promise<void>>>();

export function syncWorkoutsAutomatically(runtime: Runtime, id: number, android = false) {
  let provider: string | null;
  const workouts = new Workouts(runtime);

  try {
    provider = workouts.provider(id);
  } catch {
    console.warn(`Automatic workout provider unavailable for rider ${id}`);

    return Promise.resolve();
  }

  if (!provider || (android && provider !== 'intervals-icu')) return Promise.resolve();
  const requests = pending.get(runtime) ?? new Map<string, Promise<void>>();
  pending.set(runtime, requests);
  const key = `${id}:${provider}`;
  const previous = requests.get(key);

  if (previous) return previous;

  const request = workouts
    .sync(id, AbortSignal.timeout(5000))
    .then(() => {})
    .catch(() => {
      console.warn(`Automatic workout sync failed for rider ${id}; retaining cached workouts`);
    })
    .finally(() => {
      requests.delete(key);
    });

  requests.set(key, request);

  return request;
}
