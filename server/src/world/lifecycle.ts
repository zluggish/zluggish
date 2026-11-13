import { CryptoRepository } from '#src/repositories/crypto.repository';
import { LoggingRepository } from '#src/repositories/logging.repository';

interface Ride {
  rideId: string;
  started: number;
  progress: number;
  distance: number;
  counterReset: boolean;
}

/** Observes accepted real-rider state only; never changes protocol state. */
export class Lifecycle {
  readonly rides = new Map<bigint, Ride>();
  private readonly clients = new Map<bigint, { clientId: string; seen: number }>();
  private readonly companions = new Map<bigint, number>();
  private readonly diagnostics = new Map<string, { time: number; suppressed: number }>();
  constructor(
    public log: LoggingRepository = new LoggingRepository(),
    public intervalSeconds = 60,
    private readonly now = () => performance.now(),
    private readonly id = new CryptoRepository().randomUUID,
  ) {}

  connected(playerId: bigint) {
    const previous = this.clients.get(playerId);

    if (previous) {
      previous.seen = this.now();

      return;
    }

    const clientId = this.id();
    this.clients.set(playerId, { clientId, seen: this.now() });
    this.log.info('game.connected', 'Game connected', { playerId, clientId });
  }

  companion(playerId: bigint) {
    const now = this.now();
    const previous = this.companions.get(playerId);
    this.companions.delete(playerId);
    this.companions.set(playerId, now);

    // Registrations do not establish a persistent connection. Bound and expire
    // deduplication state without fabricating a companion disconnect event.
    if (this.companions.size > 1000) {
      const oldest = this.companions.keys().next().value;

      if (oldest !== undefined) this.companions.delete(oldest);
    }

    if (previous !== undefined && now - previous < 120_000) return;
    this.log.info('companion.registered', 'Companion app registered', { playerId, signal: 'phone_registration' });
  }

  receive(playerId: bigint, distance: number, courseId: number, routeId: bigint, sport: number) {
    const now = this.now();
    let ride = this.rides.get(playerId);

    if (!ride) {
      ride = { rideId: this.id(), started: now, progress: now, distance, counterReset: false };
      this.rides.set(playerId, ride);
      this.log.info('ride.started', 'Rider entered a ride', {
        playerId,
        rideId: ride.rideId,
        courseId,
        routeId,
        sport,
      });
    }

    ride.counterReset ||= distance < ride.distance;
    ride.distance = distance;

    if (!this.intervalSeconds || now - ride.progress < this.intervalSeconds * 1000) return;
    ride.progress = now;
    this.log.info('ride.progress', 'Ride progress', {
      playerId,
      rideId: ride.rideId,
      elapsedSeconds: Math.floor((now - ride.started) / 1000),
      distanceMeters: distance,
      counterReset: ride.counterReset,
      courseId,
      routeId,
    });
    ride.counterReset = false;
  }

  end(playerId: bigint, reason: string) {
    const ride = this.rides.get(playerId);
    this.rides.delete(playerId);

    if (ride)
      this.log.info('ride.ended', 'Ride ended', {
        playerId,
        rideId: ride.rideId,
        reason,
        distanceMeters: ride.distance,
        elapsedSeconds: Math.floor((this.now() - ride.started) / 1000),
      });
    const clientId = this.clients.get(playerId)?.clientId;
    this.clients.delete(playerId);
    this.companions.delete(playerId);

    if (clientId) this.log.info('game.disconnected', 'Game disconnected', { playerId, clientId, reason });
  }

  diagnostic(event: string, message: string, warning = false) {
    const now = this.now();
    const previous = this.diagnostics.get(event);

    if (previous && now - previous.time < 60_000) {
      previous.suppressed++;

      return;
    }

    const write = warning ? this.log.warn : this.log.verbose;
    write(event, message, { suppressed: previous?.suppressed ?? 0 });

    if (this.diagnostics.size >= 100) this.diagnostics.clear();
    this.diagnostics.set(event, { time: now, suppressed: 0 });
  }

  prune() {
    const now = this.now();

    for (const [id, client] of this.clients) {
      if (!this.rides.has(id) && now - client.seen >= 30_000) this.end(id, 'inactivity_timeout');
    }

    for (const [id, seen] of this.companions) if (now - seen >= 120_000) this.companions.delete(id);
  }

  close() {
    for (const id of new Set([...this.clients.keys(), ...this.rides.keys()])) this.end(id, 'shutdown');
    this.companions.clear();
    this.diagnostics.clear();
  }
}
