import type { DescMessage } from '@bufbuild/protobuf';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { randomUUID } from '#src/repositories/crypto.repository';
import {
  closeSync,
  existsSync,
  readFileSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

function syncDirectory(path: string) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');

  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeDurable(path: string, text: string | Uint8Array, replace = false) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);

  try {
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    if (replace) renameSync(temporary, path);
    else {
      linkSync(temporary, path);
      unlinkSync(temporary);
    }

    syncDirectory(dirname(path));
  } finally {
    rmSync(temporary, { force: true });
  }
}

// Shared filesystem primitives for repositories that manage opaque assets.
export { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';

export class AssetFiles {
  readData<Schema extends DescMessage>(schema: Schema, path: string) {
    return existsSync(path) ? fromBinary(schema, readFileSync(path)) : create(schema);
  }
  saveData<Schema extends DescMessage>(schema: Schema, path: string, value: ReturnType<typeof create<Schema>>) {
    writeDurable(path, toBinary(schema, value), true);
  }
  write(path: string, data: Uint8Array) {
    writeDurable(path, data, true);
  }
  read(path: string) {
    return existsSync(path) ? readFileSync(path) : null;
  }
  remove(path: string) {
    if (existsSync(path)) unlinkSync(path);
  }
}
