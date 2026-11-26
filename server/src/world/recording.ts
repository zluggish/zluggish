import { t } from '#src/i18n/index';
import type { PlayerState } from '#src/protocol/generated/udp-node-msgs_pb';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { course, forward, road } from '#src/world/state';
import { fromBinary } from '@bufbuild/protobuf';
import { BinaryReader, WireType } from '@bufbuild/protobuf/wire';

const statesField = 2;

/**
Ghost file with its states kept as encoded bytes plus a few typed-array columns for searching.
A decoded PlayerState costs about 13x its wire size, so states are decoded on demand only.
*/
export class Recording {
  private readonly bytes: Uint8Array;

  private readonly offsets: Uint32Array;

  private readonly sizes: Uint32Array;

  private readonly roadTimes: Int32Array;

  private readonly xs: Float32Array;

  private readonly zs: Float32Array;

  private readonly courses: Uint8Array;

  private readonly roads: Uint16Array;

  private readonly forwards: Uint8Array;

  readonly length: number;

  /** Throws on invalid input, like decoding the Ghost message. */
  constructor(file: Uint8Array) {
    this.bytes = new Uint8Array(file);
    const offsets: Array<number> = [];
    const sizes: Array<number> = [];
    const reader = new BinaryReader(this.bytes);

    while (reader.pos < reader.len) {
      const [field, wireType] = reader.tag();

      if (field === statesField && wireType === WireType.LengthDelimited) {
        const slice = reader.bytes();
        offsets.push(slice.byteOffset - this.bytes.byteOffset);
        sizes.push(slice.byteLength);
      } else {
        reader.skip(wireType);
      }
    }

    this.length = offsets.length;
    this.offsets = Uint32Array.from(offsets);
    this.sizes = Uint32Array.from(sizes);
    this.roadTimes = new Int32Array(this.length);
    this.xs = new Float32Array(this.length);
    this.zs = new Float32Array(this.length);
    this.courses = new Uint8Array(this.length);
    this.roads = new Uint16Array(this.length);
    this.forwards = new Uint8Array(this.length);

    for (let i = 0; i < this.length; i++) {
      const state = this.state(i);
      this.roadTimes[i] = state.roadTime;
      this.xs[i] = state.x;
      this.zs[i] = state.z;
      this.courses[i] = course(state);
      this.roads[i] = road(state);
      this.forwards[i] = forward(state) ? 1 : 0;
    }
  }

  state(index: number): PlayerState {
    const offset = this.offsets[index];
    const size = this.sizes[index];

    if (offset === undefined || size === undefined) {
      throw new RangeError(t('recording_state_missing', { value1: index }));
    }

    return fromBinary(PlayerStateSchema, this.bytes.subarray(offset, offset + size));
  }

  roadTime(index: number) {
    return this.roadTimes[index] ?? 0;
  }

  x(index: number) {
    return this.xs[index] ?? 0;
  }

  z(index: number) {
    return this.zs[index] ?? 0;
  }

  course(index: number) {
    return this.courses[index] ?? 0;
  }

  /** Index of the state on the same course, road and direction with the closest roadTime; first wins ties. */
  nearest(state: PlayerState) {
    const wantedCourse = course(state);
    const wantedRoad = road(state);
    const wantedForward = forward(state) ? 1 : 0;
    let index: number | null = null;
    let distance = Infinity;

    for (let i = 0; i < this.length; i++) {
      if (!(this.courses[i] === wantedCourse && this.roads[i] === wantedRoad && this.forwards[i] === wantedForward)) {
        continue;
      }

      const delta = Math.abs(state.roadTime - (this.roadTimes[i] ?? 0));

      if (!(delta < distance)) {
        continue;
      }

      index = i;
      distance = delta;
    }

    return index;
  }
}
