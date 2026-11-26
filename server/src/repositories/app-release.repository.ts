import { t } from '#src/i18n/index';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Where each patched app's releases appear. APKMirror's feed only tells what exists; APKPure also hands out files. */
export const releaseSources = {
  zwift: {
    packageName: 'com.zwift.zwiftgame',
    feed: 'https://www.apkmirror.com/apk/zwift-inc/zwift/feed/',
  },
  companion: {
    packageName: 'com.zwift.android.prod',
    feed: 'https://www.apkmirror.com/apk/zwift-inc/zwift-companion/feed/',
  },
} as const;

export type ReleaseApp = keyof typeof releaseSources;

export interface MirrorRelease {
  readonly versionName: string;
  readonly versionCode: number | null;
  /** The release page, where an administrator picks the file to download by hand. */
  readonly url: string;
  readonly publishedAt: string | null;
}

export interface PureRelease {
  readonly versionName: string;
  readonly versionCode: number | null;
  readonly bytes: number | null;
  readonly filename: string;
  /** A signed download link. It expires, so it is resolved again right before each download. */
  readonly url: string;
}

/** APKPure answers bare clients with a challenge page, so requests look like a browser following a link. */
const browserHeaders = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};
const pureHeaders = { ...browserHeaders, Referer: 'https://apkpure.com/' };

/** The numeric parts of a version name; a part that is not a number counts as 0. */
const versionParts = (version: string) => version.split(/[.-]/).map((part) => Number(part) || 0);

const entities = new Map(Object.entries({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }));

function decode(text: string) {
  return text
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
    .replaceAll(/&(amp|lt|gt|quot|apos|#\d+);/g, (_, name: string) =>
      name.startsWith('#') ? String.fromCodePoint(Number(name.slice(1))) : (entities.get(name) ?? ''),
    )
    .trim();
}

export class AppReleaseRepository {
  /** Compare dotted version names part by part as numbers, so 1.10.0 is newer than 1.9.0. */
  static compareVersions(a: string, b: string) {
    const left = versionParts(a);
    const right = versionParts(b);

    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      const difference = (left[index] ?? 0) - (right[index] ?? 0);

      if (difference !== 0) {
        return Math.sign(difference);
      }
    }

    return 0;
  }

  /** The newest stable release in an APKMirror feed. Titles read like "Zwift Companion 3.92.0 by Zwift, Inc.". */
  static parseMirrorFeed(xml: string): MirrorRelease | null {
    const releases = xml
      .matchAll(/<item>([\s\S]*?)<\/item>/g)
      .map(([, item = '']) => {
        const field = (name: string) => {
          const value = new RegExp(String.raw`<${name}>([\s\S]*?)</${name}>`).exec(item)?.[1];

          return value === undefined ? null : decode(value);
        };
        const title = field('title') ?? '';
        const version = /\s(\d+(?:\.\d+)+)(?:\s+\((\d+)\))?\s+by\s/.exec(title);
        const url = field('link');

        if (!version?.[1] || !url || /\b(?:alpha|beta)\b/i.test(title)) {
          return null;
        }
        const published = field('pubDate');

        return {
          versionName: version[1],
          versionCode: version[2] ? Number(version[2]) : null,
          url,
          publishedAt: published && !Number.isNaN(Date.parse(published)) ? new Date(published).toISOString() : null,
        };
      })
      .filter((release) => release !== null)
      .toArray();

    return releases.toSorted((a, b) => AppReleaseRepository.compareVersions(b.versionName, a.versionName))[0] ?? null;
  }

  /** What an APKPure download link offers, read from the file name it carries, such as
  `Zwift Companion_3.91.2_APKPure.apk` or `Zwift: Indoor Cycling Fitness_1.126.0 (169052)_APKPure.xapk`.
  */
  static parsePureLink(link: string): PureRelease | null {
    let url: URL;

    try {
      url = new URL(link);
    } catch {
      return null;
    }
    const filename = url.searchParams.get('filename') ?? '';
    const version = /_(\d+(?:\.\d+)+)(?:\s*\((\d+)\))?_APKPure\.(?:xapk|apk)$/i.exec(filename);

    if (!version?.[1]) {
      return null;
    }
    const bytes = Number(url.searchParams.get('full_size'));

    return {
      versionName: version[1],
      versionCode: version[2] ? Number(version[2]) : null,
      bytes: Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null,
      filename,
      url: link,
    };
  }

  async apkmirror(feed: string, signal?: AbortSignal): Promise<MirrorRelease | null> {
    const response = await fetch(feed, { headers: browserHeaders, signal: signal ?? null });

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(t('app_release_source_error', { value1: 'APKMirror', value2: response.status }));
    }

    return AppReleaseRepository.parseMirrorFeed(await response.text());
  }

  /** The latest APKPure release, from the redirect its download link answers with. Nothing is downloaded. */
  async apkpure(packageName: string, signal?: AbortSignal): Promise<PureRelease | null> {
    const response = await fetch(`https://d.apkpure.com/b/XAPK/${encodeURIComponent(packageName)}?version=latest`, {
      headers: pureHeaders,
      redirect: 'manual',
      signal: signal ?? null,
    });
    await response.body?.cancel();
    const location = response.headers.get('location');

    if (response.status < 300 || response.status >= 400 || !location) {
      throw new Error(t('app_release_source_error', { value1: 'APKPure', value2: response.status }));
    }

    return AppReleaseRepository.parsePureLink(location);
  }

  /** Stream a release to `output`, refusing anything larger than `limit`. Progress moves in whole percents. */
  async download(
    url: string,
    output: string,
    limit: number,
    signal: AbortSignal,
    progress?: (fraction: number) => void,
  ) {
    const response = await fetch(url, { headers: pureHeaders, signal });

    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(t('app_release_download_error', { value1: response.status }));
    }
    const length = Number(response.headers.get('content-length')) || null;

    if (length !== null && length > limit) {
      await response.body.cancel();
      throw new Error(t('app_release_download_too_large', { value1: Math.round(limit / 1e9) }));
    }

    let received = 0;
    let shown = 0;
    const count = new Transform({
      transform(chunk: Buffer, _encoding, next) {
        received += chunk.length;

        if (length && received / length - shown >= 0.01) {
          shown = received / length;
          progress?.(Math.min(1, shown));
        }
        next(
          received > limit ? new Error(t('app_release_download_too_large', { value1: Math.round(limit / 1e9) })) : null,
          chunk,
        );
      },
    });

    await pipeline(Readable.from(response.body), count, createWriteStream(output, { flags: 'wx', mode: 0o600 }), {
      signal,
    });

    if (length !== null && received !== length) {
      throw new Error(t('app_release_download_incomplete'));
    }
    progress?.(1);

    return received;
  }
}
