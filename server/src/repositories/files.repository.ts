import { CryptoRepository } from '#src/repositories/crypto.repository';
import { Metric, metrics } from '#src/repositories/metrics.repository';
import type { DescMessage } from '@bufbuild/protobuf';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  closeSync,
  createReadStream,
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
import { link, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

function syncDirectory(path: string) {
  if (process.platform === 'win32') {
    return;
  }
  const fd = openSync(path, 'r');

  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// temporary -> fsynced -> linked/renamed -> directory synced; failure retains no success marker.
function publish(path: string, text: string | Uint8Array, replace: boolean) {
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
    if (replace) {
      renameSync(temporary, path);
    } else {
      linkSync(temporary, path);
      unlinkSync(temporary);
    }

    syncDirectory(dirname(path));
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function syncDirectoryAsync(path: string) {
  if (process.platform === 'win32') {
    return;
  }
  const handle = await open(path, 'r');

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeSynced(path: string, data: string | Uint8Array) {
  const handle = await open(path, 'wx', 0o600);

  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// The same publication steps as publish(); libuv runs each step off the main thread.
async function publishAsync(path: string, data: string | Uint8Array, replace: boolean) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${new CryptoRepository().randomUUID()}.tmp`;

  try {
    await writeSynced(temporary, data);

    if (replace) {
      await rename(temporary, path);
    } else {
      await link(temporary, path);
      await unlink(temporary);
    }

    await syncDirectoryAsync(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

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
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }

  writeDurable(path: string, text: string | Uint8Array, replace = false) {
    // Callers pass this method unbound, so it must not use `this`.
    metrics.time(Metric.DurableWrite, () => publish(path, text, replace));
  }

  renameSync = renameSync;

  syncDirectoryAsync(path: string) {
    return syncDirectoryAsync(path);
  }

  async removeAsync(path: string) {
    await rm(path, { force: true });
  }

  writeDurableAsync(path: string, data: string | Uint8Array, replace = false) {
    return metrics.timeAsync(Metric.DurableWrite, () => publishAsync(path, data, replace));
  }

  /** Flush an unpublished attempt's contents. The caller owns cleanup and syncs the directory after publication. */
  writeStagedAsync(path: string, data: string | Uint8Array) {
    return metrics.timeAsync(Metric.DurableWrite, async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeSynced(path, data);
    });
  }

  async readAsync(path: string) {
    try {
      return await readFile(path);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async statAsync(path: string) {
    try {
      const info = await stat(path);

      return {
        bytes: info.size,
        modified: info.mtimeMs,
        directory: info.isDirectory(),
        identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
      };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /** No await between identity/ownership checks and unlink: local publishers cannot interleave. */
  removeUnchanged(path: string, identity: string, eligible: () => boolean) {
    if (!existsSync(path)) {
      return false;
    }
    const info = lstatSync(path);
    const current = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

    if (current !== identity || !eligible()) {
      return false;
    }
    rmSync(path, { recursive: true, force: true });

    return true;
  }

  async removeTreeAsync(path: string) {
    await rm(path, { recursive: true, force: true });
  }

  /** Directory entries; a missing directory has none. */
  async entriesAsync(folder: string) {
    try {
      return await readdir(folder, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /** Files below folder whose names end with suffix; a missing folder has none. */
  async filesUnder(folder: string, suffix: string): Promise<Array<string>> {
    const entries = await this.entriesAsync(folder);

    const nested = await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? this.filesUnder(resolve(folder, entry.name), suffix)
          : Promise.resolve(entry.isFile() && entry.name.endsWith(suffix) ? [resolve(folder, entry.name)] : []),
      ),
    );

    return nested.flat();
  }

  createReadStream = createReadStream;

  existsSync = existsSync;

  lstatSync = lstatSync;

  mkdirSync = mkdirSync;

  readdirSync = readdirSync;

  readFileSync = readFileSync;

  rmSync = rmSync;

  statSync = statSync;

  unlinkSync = unlinkSync;
}
