import { CryptoRepository } from '#src/repositories/crypto.repository';
import type { DescMessage } from '@bufbuild/protobuf';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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

// Shared filesystem primitives for repositories that manage opaque assets.

export class AssetFiles {
  readData<Schema extends DescMessage>(schema: Schema, path: string) {
    return existsSync(path) ? fromBinary(schema, readFileSync(path)) : create(schema);
  }
  saveData<Schema extends DescMessage>(schema: Schema, path: string, value: ReturnType<typeof create<Schema>>) {
    this.writeDurable(path, toBinary(schema, value), true);
  }
  write(path: string, data: Uint8Array) {
    this.writeDurable(path, data, true);
  }
  read(path: string) {
    return existsSync(path) ? readFileSync(path) : null;
  }
  remove(path: string) {
    if (existsSync(path)) unlinkSync(path);
  }

  // temporary -> fsynced -> linked/renamed -> directory synced; failure retains no success marker.
  writeDurable(path: string, text: string | Uint8Array, replace = false) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${new CryptoRepository().randomUUID()}.tmp`;
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
  existsSync = existsSync;
  lstatSync = lstatSync;
  mkdirSync = mkdirSync;
  readdirSync = readdirSync;
  readFileSync = readFileSync;
  rmSync = rmSync;
  statSync = statSync;
  unlinkSync = unlinkSync;
}
