import type { PlayerState } from '#src/protocol/generated/udp-node-msgs_pb';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { Metric, metrics } from '#src/repositories/metrics.repository';
import { fromBinary } from '@bufbuild/protobuf';
import { BinaryWriter, sizeDelimitedPeek } from '@bufbuild/protobuf/wire';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** One append-only recording of the server-side ride history for each rider: size-
delimited PlayerState messages. A crash can cut the last record; reads stop there.
The recording is never a FIT activity: the game client owns the activity data.
*/
export class RideRecoveryRepository {
  private readonly writes = new Map<number, Promise<void>>();

  constructor(
    readonly storage: string,
    private readonly maxBytes: number,
  ) {}

  path(player: number) {
    return resolve(this.storage, String(player), 'ride-recovery.bin');
  }

  /** Appends encoded states in order for each rider. Past the size limit, nothing more is recorded. */
  append(player: number, states: ReadonlyArray<Uint8Array>) {
    const writer = new BinaryWriter();

    for (const state of states) {
      writer.bytes(state);
    }
    const data = writer.finish();

    return this.enqueue(player, () =>
      metrics.timeAsync(Metric.RecoveryAppend, async () => {
        const path = this.path(player);

        const size = await stat(path)
          .then((info) => info.size)
          .catch(() => 0);

        if (size + data.length > this.maxBytes) {
          return;
        }
        await mkdir(dirname(path), { recursive: true });
        const handle = await open(path, 'a', 0o600);

        try {
          await handle.write(data);
          await handle.sync();
        } finally {
          await handle.close();
        }

        metrics.record(Metric.RecoveryBytes, size + data.length);
      }),
    );
  }

  async read(player: number) {
    await this.writes.get(player);
    const path = this.path(player);
    let data: Uint8Array;
    let modified: number;

    try {
      [data, modified] = await Promise.all([readFile(path), stat(path).then((info) => info.mtimeMs)]);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }

    const states: Array<PlayerState> = [];
    let rest = data;

    for (;;) {
      const peek = sizeDelimitedPeek(rest);

      if (peek.eof || peek.offset + peek.size > rest.length) {
        break;
      }

      try {
        states.push(fromBinary(PlayerStateSchema, rest.subarray(peek.offset, peek.offset + peek.size)));
      } catch {
        break;
      }

      rest = rest.subarray(peek.offset + peek.size);
    }

    return { states, modified };
  }

  remove(player: number) {
    return this.enqueue(player, () => rm(this.path(player), { force: true }));
  }

  /** Runs after the player's pending writes and removals, so later reads and removals see their effects. */
  private enqueue(player: number, task: () => Promise<void>): Promise<void> {
    const write = (this.writes.get(player) ?? Promise.resolve()).then(task);
    const settled = write.catch(() => {});
    this.writes.set(player, settled);
    void settled.finally(() => {
      if (this.writes.get(player) === settled) {
        this.writes.delete(player);
      }
    });
    return write;
  }

  async idle() {
    await Promise.all(this.writes.values());
  }
}
