import { t } from '#src/i18n/index';
import { ConfigError } from '#src/config/index';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export const archiveSuffix = '.tar.gz';

export async function compressBackup(source: string, output: string, signal?: AbortSignal) {
  const result = Promise.withResolvers<void>();

  const tar = execFile('tar', ['-czf', output, '-C', source, '.'], { signal }, (error) => {
    if (error) {
      result.reject(error);
    } else {
      result.resolve();
    }
  });

  // The abort callback can run before tar has closed the staging files.
  const closed = new Promise<void>((resolve) => {
    tar.once('close', () => resolve());
  });
  try {
    await result.promise;
  } finally {
    await closed;
  }
}

export function compressBackupSync(source: string, output: string) {
  execFileSync('tar', ['-czf', output, '-C', source, '.']);
}

export function readArchivedFile(input: string, name: string) {
  return execFileSync('tar', ['-xOzf', input, `./${name}`], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
}

/** Run against a directory backup or unpack an archive into a private temporary directory. */
export function withBackupDirectory<T>(input: string, use: (directory: string) => T): T {
  if (!statSync(input).isFile()) {
    return use(input);
  }
  const stage = mkdtempSync(resolve(tmpdir(), 'zluggish-restore-'));

  try {
    execFileSync('tar', ['-xzf', input, '-C', stage, '--no-same-owner', '--no-same-permissions']);
    const entries = readdirSync(stage, { recursive: true, withFileTypes: true });

    if (entries.some((entry) => !entry.isFile() && !entry.isDirectory())) {
      throw new ConfigError(t('backup_archive_file_type_unsupported'));
    }

    return use(stage);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
