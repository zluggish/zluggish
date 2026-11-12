import {
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  linkSync,
  unlinkSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

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
