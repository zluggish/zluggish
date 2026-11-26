import { t } from '#src/i18n/index';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

interface Download {
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Eclipse Temurin 21 JREs, pinned by checksum. Adoptium publishes them at https://adoptium.net. */
const runtimes = {
  'linux-x64': {
    url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13.1%2B2/OpenJDK21U-jre_x64_linux_hotspot_21.0.13.1_2.tar.gz',
    sha256: '18f44fab9065217f3ba61d0eef8a7b5f3c3713aa7293001b0d4ac10ede3850f0',
    bytes: 52_190_567,
  },
  'linux-arm64': {
    url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jre_aarch64_linux_hotspot_21.0.13_9.tar.gz',
    sha256: 'b1734db7ade49c3f6acc6ae06233b8c2dd90e3e2f00f67000ae1c972aaa64d8c',
    bytes: 51_266_660,
  },
  'darwin-x64': {
    url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jre_x64_mac_hotspot_21.0.13_9.tar.gz',
    sha256: 'c909674b1c10c261b9a3fb7e9c0efebd303e33f88a4fe84be7135b5e2d711f89',
    bytes: 41_902_098,
  },
  'darwin-arm64': {
    url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13.1%2B2/OpenJDK21U-jre_aarch64_mac_hotspot_21.0.13.1_2.tar.gz',
    sha256: '848feb1906c7de79de4f8391636042193fbd46eff86e26299506c4656f62c260',
    bytes: 47_946_379,
  },
  'win32-x64': {
    url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jre_x64_windows_hotspot_21.0.13_9.zip',
    sha256: '2332c0b4cff6bed722da3567c91d5e47568bcba863fa4945d0a8d6fc76158628',
    bytes: 49_106_397,
  },
} satisfies Record<string, Download>;

/** APKEditor merges split APKs and decodes and rebuilds resources. It is pure Java: no native tools. */
const editor = {
  version: '1.4.9',
  url: 'https://github.com/REAndroid/APKEditor/releases/download/V1.4.9/APKEditor-1.4.9.jar',
  sha256: 'a9cd40df818845456be6d696de6110c89edf4b0a0580cb83438ed6b25a366e67',
  bytes: 7_733_037,
} as const;

/** The oldest Java that runs APKEditor reliably. */
const minimumJava = 11;

export interface JavaRuntime {
  readonly source: 'managed' | 'system';
  readonly command: string;
  readonly version: string;
}

export interface ToolchainState {
  readonly java: JavaRuntime | null;
  readonly editor: boolean;
  readonly downloadBytes: number;
  /** False when no runtime is published for this system and none is installed. */
  readonly supported: boolean;
}

export type ToolchainProgress = (step: 'runtime' | 'editor', fraction: number | null) => void;

/** Runs a command and resolves with its output, or rejects with its last lines. */
function execute(command: string, args: ReadonlyArray<string>, options: { cwd?: string; signal?: AbortSignal } = {}) {
  return new Promise<string>((done, fail) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      signal: options.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let output = '';

    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-16_384);
    };

    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', fail);
    child.on('close', (code) => {
      if (code === 0) {
        done(output);
      } else {
        fail(
          new Error(
            t('toolchain_process_exit_error', {
              value1: command,
              value2: code,
              value3: output.trim().split('\n').slice(-8).join('\n'),
            }),
          ),
        );
      }
    });
  });
}

/** The Java runtime and the APK tools that a Play Store Companion app needs, downloaded when a rebuild needs them. */
export class ToolchainRepository {
  private system: Promise<JavaRuntime | null> | null = null;

  constructor(
    readonly folder: string,
    private readonly crypto = new CryptoRepository(),
  ) {}

  private get runtime(): Download | undefined {
    const key = `${platform()}-${arch()}`;

    return Object.entries(runtimes).find(([name]) => name === key)?.[1];
  }

  private get editorPath() {
    return resolve(this.folder, `APKEditor-${editor.version}.jar`);
  }

  private get runtimeFolder() {
    return resolve(this.folder, 'jre');
  }

  private async managedJava(): Promise<string | null> {
    const name = platform() === 'win32' ? 'java.exe' : 'java';

    for (const entry of await readdir(this.runtimeFolder, { recursive: true, withFileTypes: true }).catch(() => [])) {
      if (entry.name === name && entry.isFile() && entry.parentPath.endsWith('bin')) {
        return join(entry.parentPath, name);
      }
    }

    return null;
  }

  private async probe(command: string): Promise<string | null> {
    try {
      const output = await execute(command, ['-version']);
      const version = /version "([^"]+)"/.exec(output)?.[1];

      if (!version) {
        return null;
      }
      const major = Number(version.startsWith('1.') ? version.split('.', 2)[1] : version.split(/[.+-]/, 1)[0]);

      return major >= minimumJava ? version : null;
    } catch {
      return null;
    }
  }

  private async java(): Promise<JavaRuntime | null> {
    const managed = await this.managedJava();

    if (managed) {
      const version = await this.probe(managed);

      if (version) {
        return { source: 'managed', command: managed, version };
      }
    }

    this.system ??= this.probe('java').then((version) =>
      version ? { source: 'system', command: 'java', version } : null,
    );

    return this.system;
  }

  private async exists(path: string) {
    const info = await stat(path).catch(() => null);

    return info?.isFile() ?? false;
  }

  async state(): Promise<ToolchainState> {
    const java = await this.java();
    const hasEditor = await this.exists(this.editorPath);

    return {
      java,
      editor: hasEditor,
      downloadBytes: (java ? 0 : (this.runtime?.bytes ?? 0)) + (hasEditor ? 0 : editor.bytes),
      supported: !!java || !!this.runtime,
    };
  }

  /** Download what is missing, check each file against its pinned checksum, and unpack the runtime. */
  async install(signal: AbortSignal, progress: ToolchainProgress) {
    await mkdir(this.folder, { recursive: true });

    if (!(await this.java())) {
      const runtime = this.runtime;

      if (!runtime) {
        throw new Error(
          t('toolchain_java_platform_unsupported', {
            value1: platform(),
            value2: arch(),
          }),
        );
      }
      const archive = resolve(this.folder, runtime.url.endsWith('.zip') ? 'jre.zip' : 'jre.tar.gz');
      const staging = resolve(this.folder, 'jre.staging');

      try {
        await this.download(runtime, archive, signal, (fraction) => progress('runtime', fraction));
        progress('runtime', null);
        await rm(staging, { recursive: true, force: true });
        await mkdir(staging, { recursive: true });
        // tar unpacks zip archives too on Windows 10 and later.
        await execute('tar', [runtime.url.endsWith('.zip') ? '-xf' : '-xzf', archive, '-C', staging], { signal });
        await rm(this.runtimeFolder, { recursive: true, force: true });
        await rename(staging, this.runtimeFolder);
      } finally {
        await rm(archive, { force: true });
        await rm(staging, { recursive: true, force: true });
      }

      if (!(await this.java())) {
        throw new Error(t('toolchain_java_startup_failed'));
      }
    }

    if (await this.exists(this.editorPath)) {
      return;
    }
    const temporary = `${this.editorPath}.download`;

    try {
      await this.download(editor, temporary, signal, (fraction) => progress('editor', fraction));
      await rename(temporary, this.editorPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** Remove everything this downloaded. A system Java stays. */
  async remove() {
    await rm(this.folder, { recursive: true, force: true });
    this.system = null;
  }

  async editor(args: ReadonlyArray<string>, options: { cwd: string; signal: AbortSignal }) {
    const java = await this.java();

    if (!java || !(await this.exists(this.editorPath))) {
      throw new Error(t('toolchain_java_tools_missing'));
    }

    return execute(java.command, ['-Djava.awt.headless=true', '-jar', this.editorPath, ...args], options);
  }

  private async download(file: Download, target: string, signal: AbortSignal, progress: (fraction: number) => void) {
    const response = await fetch(file.url, { signal });

    if (!response.ok || !response.body) {
      throw new Error(t('toolchain_download_http_error', { value1: file.url, value2: response.status }));
    }
    let received = 0;

    const count = new Transform({
      transform(chunk: Buffer, _encoding, next) {
        received += chunk.length;

        if (received > file.bytes) {
          next(new Error(t('toolchain_download_size_limit', { value1: file.url })));

          return;
        }

        progress(received / file.bytes);
        next(null, chunk);
      },
    });

    // SAFETY: fetch returns a WHATWG byte stream; Node and DOM stream declarations differ in their BYOB overloads.
    await pipeline(Readable.from(response.body), count, createWriteStream(target, { mode: 0o644 }), {
      signal,
    });

    if ((await this.crypto.sha256FileAsync(target)) !== file.sha256) {
      throw new Error(t('toolchain_checksum_mismatch', { value1: file.url }));
    }
  }
}
