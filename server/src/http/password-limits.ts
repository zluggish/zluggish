/** Process-local admission control shared by the game password endpoints. No waiting queue. */
export class PasswordLimits {
  private readonly peers = new Map<string, { count: number; expires: number }>();

  private readonly accounts = new Map<number, { count: number; expires: number }>();

  private readonly hashing = new Set<number>();

  private active = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private expire<K>(entries: Map<K, { expires: number }>, now: number) {
    for (const [key, entry] of entries) {
      if (entry.expires <= now) {
        entries.delete(key);
      }
    }
  }

  acquire(peer: string, account: number | undefined): (() => void) | null {
    const now = this.now();

    this.expire(this.peers, now);
    this.expire(this.accounts, now);

    const peerEntry = this.peers.get(peer);
    const accountEntry = account === undefined ? undefined : this.accounts.get(account);

    // Keep live buckets when full: evicting them would let rotating peers bypass the limits.
    if (
      (!peerEntry && this.peers.size >= 4096) ||
      (account !== undefined && !accountEntry && this.accounts.size >= 4096) ||
      (peerEntry?.count ?? 0) >= 30 ||
      (accountEntry?.count ?? 0) >= 10
    ) {
      return null;
    }
    this.peers.set(peer, { count: (peerEntry?.count ?? 0) + 1, expires: peerEntry?.expires ?? now + 60_000 });
    if (account !== undefined) {
      this.accounts.set(account, {
        count: (accountEntry?.count ?? 0) + 1,
        expires: accountEntry?.expires ?? now + 60_000,
      });
    }

    if (this.active >= 4 || (account !== undefined && this.hashing.has(account))) {
      return null;
    }
    this.active++;
    if (account !== undefined) {
      this.hashing.add(account);
    }
    let released = false;

    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active--;
      if (account !== undefined) {
        this.hashing.delete(account);
      }
    };
  }
}
