import { AppReleaseRepository } from '#src/repositories/app-release.repository';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { compareVersions, parseMirrorFeed, parsePureLink } = AppReleaseRepository;

const item = (title: string, link: string, date: string) =>
  `<item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate></item>`;

await test('reads the newest stable release from an APKMirror feed', () => {
  const feed = `<?xml version="1.0"?><rss><channel><title>Download Example APKs - APKMirror</title>
${item('Example 3.91.2 by Example, Inc.', 'https://example.test/3-91-2/', 'Mon, 09 Nov 2026 22:15:49 +0000')}
${item('Example 3.93.0 beta by Example, Inc.', 'https://example.test/3-93-0-beta/', 'Tue, 24 Nov 2026 10:00:00 +0000')}
${item('Example 3.92.0 by Example, Inc.', 'https://example.test/3-92-0/', 'Mon, 23 Nov 2026 20:42:17 +0000')}
</channel></rss>`;

  assert.deepEqual(parseMirrorFeed(feed), {
    versionName: '3.92.0',
    versionCode: null,
    url: 'https://example.test/3-92-0/',
    publishedAt: '2026-11-23T20:42:17.000Z',
  });
});

await test('keeps the version code an APKMirror title carries and decodes entities', () => {
  const feed = item(
    'Example: Indoor &amp; Outdoor 1.126.0 (169052) by Example, Inc.',
    'https://example.test/a?b=1&amp;c=2',
    'Wed, 18 Nov 2026 19:56:05 +0000',
  );

  assert.deepEqual(parseMirrorFeed(feed), {
    versionName: '1.126.0',
    versionCode: 169_052,
    url: 'https://example.test/a?b=1&c=2',
    publishedAt: '2026-11-18T19:56:05.000Z',
  });
  assert.equal(parseMirrorFeed('<rss><channel></channel></rss>'), null);
});

await test('reads the version and size from an APKPure download link', () => {
  const xapk = parsePureLink(
    'https://files.example.test/XAPK/abc?filename=Example%3A+Indoor+Cycling_1.126.0+%28169052%29_APKPure.xapk&full_size=1949632327&token=x',
  );
  assert.deepEqual(xapk && { ...xapk, url: '' }, {
    versionName: '1.126.0',
    versionCode: 169_052,
    bytes: 1_949_632_327,
    filename: 'Example: Indoor Cycling_1.126.0 (169052)_APKPure.xapk',
    url: '',
  });

  const apk = parsePureLink('https://files.example.test/APK/abc?filename=Example+Companion_3.91.2_APKPure.apk');
  assert.equal(apk?.versionName, '3.91.2');
  assert.equal(apk?.versionCode, null);
  assert.equal(apk?.bytes, null);
  assert.equal(parsePureLink('https://files.example.test/APK/abc?filename=readme.txt'), null);
  assert.equal(parsePureLink('not a link'), null);
});

await test('compares version names part by part', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('3.91.2', '3.92.0'), -1);
  assert.equal(compareVersions('3.92', '3.92.0'), 0);
});
