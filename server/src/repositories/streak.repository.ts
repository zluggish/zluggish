import type { Streaks } from '#src/protocol/generated/profile_pb';
import { StreaksSchema } from '#src/protocol/generated/profile_pb';
import { writeDurable } from '#src/repositories/files.repository';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function readStreaks(folder: string) {
  const path = resolve(folder, 'streaks.bin');

  return existsSync(path) ? fromBinary(StreaksSchema, readFileSync(path)) : null;
}

export function saveStreaks(folder: string, streaks: Streaks) {
  writeDurable(resolve(folder, 'streaks.bin'), toBinary(StreaksSchema, streaks), true);
}
