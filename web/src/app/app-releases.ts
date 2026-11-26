import { z } from 'zod';

const app = z.object({
  apkmirror: z
    .object({
      versionName: z.string(),
      versionCode: z.number().nullable(),
      url: z.string(),
      publishedAt: z.string().nullable(),
    })
    .nullable(),
  apkpure: z
    .object({
      versionName: z.string(),
      versionCode: z.number().nullable(),
      bytes: z.number().nullable(),
      filename: z.string(),
    })
    .nullable(),
  errors: z.object({ apkmirror: z.string().nullable(), apkpure: z.string().nullable() }),
});

export const appReleasesStatus = z.object({
  enabled: z.boolean(),
  checking: z.boolean(),
  checkedAt: z.string().nullable(),
  apps: z.object({ zwift: app, companion: app }),
});

export type AppReleasesStatus = z.infer<typeof appReleasesStatus>;
export type ReleaseApp = keyof AppReleasesStatus['apps'];

/** Compare dotted version names part by part as numbers, so 1.10.0 is newer than 1.9.0. */
export function compareVersions(a: string, b: string) {
  const parts = (version: string) => version.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const left = parts(a);
  const right = parts(b);

  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);

    if (difference !== 0) {
      return Math.sign(difference);
    }
  }

  return 0;
}

/**
What a release check means for one app, given the installed version.

`download`: APKPure has a version newer than the installed one, or there is none installed, so the server can fetch it.
`mirrorOnly`: APKMirror lists an even newer version that has to be downloaded by hand.
*/
export function releaseFor(status: AppReleasesStatus | null, app: ReleaseApp, installed: string | null) {
  const release = status?.apps[app];
  const newer = (version: string | undefined) =>
    !!version && (installed === null || compareVersions(version, installed) > 0);
  const pure = release?.apkpure ?? null;
  const mirror = release?.apkmirror ?? null;
  const download = pure && newer(pure.versionName) ? pure : null;
  const mirrorOnly =
    mirror && newer(mirror.versionName) && (!pure || compareVersions(mirror.versionName, pure.versionName) > 0)
      ? mirror
      : null;

  return { download, mirrorOnly, errors: release?.errors ?? null };
}
