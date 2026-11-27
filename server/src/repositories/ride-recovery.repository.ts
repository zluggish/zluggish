import type { PlayerState } from '#src/protocol/generated/udp-node-msgs_pb';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { Metric, metrics } from '#src/repositories/metrics.repository';
import { fromBinary } from '@bufbuild/protobuf';
import { BinaryWriter, sizeDelimitedPeek } from '@bufbuild/protobuf/wire';
import { mkdir, open, readFile, rm, stat, truncate } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** The complete records at the start of a recording, and the bytes they take. */
function decode(data: Uint8Array) {
  const states: Array<PlayerState> = [];
  let length = 0;

  for (;;) {
    const rest = data.subarray(length);
    const peek = sizeDelimitedPeek(rest);

    if (peek.eof || peek.offset + peek.size > rest.length) {
      break;
    }

    try {
      states.push(fromBinary(PlayerStateSchema, rest.subarray(peek.offset, peek.offset + peek.size)));
    } catch {
      break;
    }

    length += peek.offset + peek.size;
  }

  return { states, length };
}

/** One append-only recording of the server-side ride history for each rider: size-
delimited PlayerState messages. A crash can cut the last record; reads stop there,
and the first append in a process cuts the file back to its complete records.
The recording is never a FIT activity: the game client owns the activity data.
*/
export class RideRecoveryRepository {
  private readonly writes = new Map<number, Promise<void>>();

  /** Riders whose recording ends with a complete record, as far as this process wrote it. */
  private readonly whole = new Set<number>();

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

    const write = (this.writes.get(player) ?? Promise.resolve()).then(() =>
      metrics.timeAsync(Metric.RecoveryAppend, async () => {
        const path = this.path(player);
        const size = await this.repair(player);

        if (size + data.length > this.maxBytes) {
          return;
        }
        await mkdir(dirname(path), { recursive: true });
        // A failed write can leave a partial record: the next append repairs it.
        this.whole.delete(player);
        const handle = await open(path, 'a', 0o600);

        try {
          await handle.write(data);
          await handle.sync();
        } finally {
          await handle.close();
        }
        this.whole.add(player);

        metrics.record(Metric.RecoveryBytes, size + data.length);
      }),
    );

    const settled = write.catch(() => {});
    this.writes.set(player, settled);
    void settled.finally(() => {
      if (this.writes.get(player) === settled) {
        this.writes.delete(player);
      }
    });

    return write;
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

    return { states: decode(data).states, modified };
  }

  /** Cut a recording that a crash or failed write left with a partial last record:
  appended records would otherwise follow bytes that reads stop at. Returns the size.
  */
  private async repair(player: number) {
    const path = this.path(player);

    if (this.whole.has(player)) {
      return stat(path)
        .then((info) => info.size)
        .catch(() => 0);
    }

    let data: Uint8Array;

    try {
      data = await readFile(path);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        this.whole.add(player);

        return 0;
      }
      throw error;
    }

    const { length } = decode(data);

    if (length < data.length) {
      await truncate(path, length);
    }
    this.whole.add(player);

    return length;
  }

  async remove(player: number) {
    await this.writes.get(player);
    await rm(this.path(player), { force: true });
    this.whole.add(player);
  }

  async idle() {
    await Promise.all(this.writes.values());
  }
}
