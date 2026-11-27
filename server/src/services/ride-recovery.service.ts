import { Context, Effect, Layer } from 'effect';
import { RuntimeContext } from '#src/context';
import type { PlayerState } from '#src/protocol/generated/udp-node-msgs_pb';
import { RideRecoveryRepository } from '#src/repositories/ride-recovery.repository';
import { course } from '#src/world/state';
import { StateHistory } from '#src/world/state-history';

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;

  let timer: NodeJS.Timeout | null = null;

  const written = new Map<bigint, bigint>();

  // `before` is the online state at login: the merge waits for a newer one.
  const pendingResumes = new Map<
    bigint,
    { states: Array<PlayerState>; generation: number; before: PlayerState | undefined }
  >();

  const recordings = new RideRecoveryRepository(context.config.storageDir, context.config.recovery.maxBytes);

  function start() {
    context.world.sessions = {
      login: (id) => {
        void resume(id);
      },
      logout: (id, reason) => {
        // A lost connection can come back within the resume window; other ends cannot.
        if (reason !== 'inactivity_timeout') {
          discard(id);
        }
      },
    };

    if (timer) {
      return;
    }
    timer = setInterval(() => void checkpoint(), context.config.recovery.checkpointSeconds * 1000);
    timer.unref();
  }

  async function checkpoint() {
    merge();
    const appends = [];

    for (const [id, history] of context.world.histories) {
      const last = written.get(id) ?? -1n;
      const fresh = history.since(last);
      const newest = history.worldTime(-1);

      if (fresh.length === 0 || newest === undefined) {
        continue;
      }
      // Set before the write so an overlapping checkpoint does not append the same samples.
      written.set(id, newest);
      appends.push(
        recordings.append(Number(id), fresh).catch(() => {
          // The next checkpoint writes these samples again, unless a newer one has already moved on.
          if (written.get(id) === newest) {
            if (last < 0n) {
              written.delete(id);
            } else {
              written.set(id, last);
            }
          }
          context.world.lifecycle.log.warn('ride.recovery_failed', 'Ride recovery checkpoint failed', {
            playerId: id,
          });
        }),
      );
    }

    await Promise.all(appends);
  }

  /** A new session: keep a recent recording for the first state, discard an old one. */
  function resume(id: bigint) {
    written.delete(id);
    pendingResumes.delete(id);
    const generation = context.world.generation(id);
    const before = context.world.online.get(id);

    return recordings
      .read(Number(id))
      .then(async (found) => {
        if (!found || context.world.generation(id) !== generation) {
          return;
        }
        const expired = Date.now() - found.modified > context.config.recovery.resumeMinutes * 60_000;

        if (expired || found.states.length === 0) {
          await recordings.remove(Number(id));

          return;
        }

        pendingResumes.set(id, { states: found.states, generation, before });
        merge();
      })
      .catch(() => {
        context.world.lifecycle.log.warn('ride.recovery_failed', 'Ride recovery could not be read', {
          playerId: id,
        });
      });
  }

  /** Prepend recovered samples once the session's first state shows the same course. */
  function merge() {
    const world = context.world;

    for (const [id, pending] of pendingResumes) {
      if (world.generation(id) !== pending.generation) {
        pendingResumes.delete(id);
        continue;
      }

      const online = world.online.get(id);

      // The state from before the login belongs to the previous session.
      if (!online || online === pending.before) {
        continue;
      }
      pendingResumes.delete(id);
      const last = pending.states.at(-1);

      if (!last || course(last) !== course(online)) {
        void recordings.remove(Number(id));
        continue;
      }

      const current = world.histories.get(id) ?? new StateHistory();
      const first = current.worldTime(0);
      const earlier = pending.states.filter((state) => first === undefined || state.worldTime < first);
      current.prepend(earlier);
      world.histories.set(id, current);
      const newest = earlier.at(-1);

      if (newest) {
        written.set(id, newest.worldTime);
      }
      world.lifecycle.log.info('ride.recovered', 'Ride history recovered', { playerId: id, samples: earlier.length });
    }
  }

  function discard(id: bigint) {
    pendingResumes.delete(id);
    written.delete(id);
    void recordings.remove(Number(id));
  }

  /** A last checkpoint at shutdown: a restart can resume every ride in progress. */
  async function close() {
    if (timer) {
      clearInterval(timer);
    }
    timer = null;
    await checkpoint();
    await recordings.idle();
  }

  return {
    recordings,

    start: Effect.fn('RideRecoveryService.start')(function* () {
      return start();
    }),
    checkpoint: Effect.fn('RideRecoveryService.checkpoint')(function* () {
      return yield* Effect.promise(() => checkpoint());
    }),
    /** A new session: keep a recent recording for the first state, discard an old one. */
    resume: Effect.fn('RideRecoveryService.resume')(function* (id: bigint) {
      return yield* Effect.promise(() => resume(id));
    }),

    discard: Effect.fn('RideRecoveryService.discard')(function* (id: bigint) {
      return discard(id);
    }),
    /** A last checkpoint at shutdown: a restart can resume every ride in progress. */
    close: Effect.fn('RideRecoveryService.close')(function* () {
      return yield* Effect.promise(() => close());
    }),
  };
});

/** Server-side recovery of unfinished rides. Every checkpoint appends the ride history
samples recorded since the previous one; no row is written for each packet. A new
session within the resume window, on the same course, gets the recorded history back.
A ride is never completed or uploaded because its connection ends.
*/
export class RideRecoveryService extends Context.Service<RideRecoveryService, Effect.Success<typeof make>>()(
  'zluggish/RideRecoveryService',
) {
  static readonly layer = Layer.effect(RideRecoveryService, make);
}
