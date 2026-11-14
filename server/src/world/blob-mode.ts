import type { BlobMode } from '#src/enum';

type Mode = { mode: null } | { mode: BlobMode; until: number };

/** Group mode only; rider effort, dropping and trail readiness are independent.
Gesture/automatic turn enters a mode; strict expiry returns to normal.
*/
export class BlobBehavior {
  private current: Mode = { mode: null };

  get mode() {
    return this.current.mode;
  }

  enter(mode: BlobMode | null, until: number) {
    this.current = mode === null ? { mode: null } : { mode, until };
  }

  expire(now: number) {
    if (this.current.mode === null || now <= this.current.until) return false;
    this.current = { mode: null };

    return true;
  }
}
