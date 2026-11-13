import { randomUUID } from 'node:crypto';
import {
  closeSync,
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
export { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
