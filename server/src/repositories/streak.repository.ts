import type { Streaks } from '#src/protocol/generated/profile_pb';
import { StreaksSchema } from '#src/protocol/generated/profile_pb';
import { AssetFiles } from '#src/repositories/files.repository';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export class StreakRepository {
  readStreaks(folder: string) {
    const path = resolve(folder, 'streaks.bin');

    return existsSync(path) ? fromBinary(StreaksSchema, readFileSync(path)) : null;
  }

  saveStreaks(folder: string, streaks: Streaks) {
    new AssetFiles().writeDurable(resolve(folder, 'streaks.bin'), toBinary(StreaksSchema, streaks), true);
  }
}
