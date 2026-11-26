import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCatalog, compareCatalogs } from './i18n-catalog.mjs';
import { createTranslator } from '../web/src/lib/i18n/translate.ts';
import { candidates } from './i18n-source.mjs';

// Exercise the guards that make extraction safe for both UI text and wire values.
test('finds Svelte text, interpolation, accessibility labels, and script errors', () => {
  const source = `<script lang="ts">const error = 'Could not save.';</script>
    <button aria-label="Retry upload">Retry in {seconds}s</button>`;
  const messages = candidates(source, 'web/src/Test.svelte');
  assert.deepEqual(
    messages.map((m) => m.value),
    ['Could not save.', 'Retry upload', 'Retry in {value1}s'],
  );
  assert.deepEqual(messages[2].args, [['value1', 'seconds']]);
});

test('ignores protocol comparisons, SQL, imports, CSS selectors, and logs', () => {
  const source = `import thing from './My Module';
    const isSent = state === 'sent';
    const sql = 'SELECT name FROM user';
    document.querySelector('input[type=text]');
    console.error('Request failed.');`;
  assert.deepEqual(candidates(source, 'server/src/example.ts'), []);
});

test('checks nested translation arguments and conditional messages', () => {
  const source = `const message = ready && 'Upload complete.';
    const other = t('existing', { value1: ok ? 'Done.' : 'Try again.' });`;
  assert.deepEqual(
    candidates(source, 'web/src/example.ts').map((m) => m.value),
    ['Upload complete.', 'Done.', 'Try again.'],
  );
});

test('interpolation preserves dollar signs and treats markup as plain text', async () => {
  const catalog = { example: 'Value: {value1}; again: {value1}' };
  const t = createTranslator(catalog);
  assert.equal(t('example', { value1: '$& <script>' }), 'Value: $& <script>; again: $& <script>');
});

test('JSON catalogs reject duplicate message keys', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zluggish-i18n-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'en.json');
  writeFileSync(file, '{"label":"First","label":"Second"}');
  const result = readCatalog(file);
  assert.equal(result.catalog, undefined);
  assert.ok(result.errors.some((error) => error.includes('duplicate key label')));
});

test('JSON catalogs reject invalid JSON and non-string values', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zluggish-i18n-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'en.json');
  writeFileSync(file, '{"label":"Label",}');
  assert.equal(readCatalog(file).catalog, undefined);
  writeFileSync(file, JSON.stringify({ label: 42 }));
  assert.ok(readCatalog(file).errors.some((error) => error.includes('label must be a nonempty string')));
});

test('JSON catalogs accept flat keys and reject nested sections and dotted keys', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zluggish-i18n-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'en.json');
  const catalog = { account: 'Account', account_settings: 'Account settings' };
  writeFileSync(file, JSON.stringify(catalog));
  assert.deepEqual(readCatalog(file), { catalog, errors: [] });
  writeFileSync(file, JSON.stringify({ app: catalog }));
  assert.ok(readCatalog(file).errors.some((error) => error.includes('app must be a nonempty string')));
  writeFileSync(file, JSON.stringify({ 'app.account': 'Account' }));
  assert.ok(readCatalog(file).errors.some((error) => error.includes('must be a flat snake_case key')));
});

test('languages must match English keys and placeholder names', () => {
  const english = { greeting: 'Hello {name}' };
  const valid = { greeting: 'Hej {name}' };
  assert.deepEqual(compareCatalogs(english, valid, 'sv.json'), []);
  const invalid = { greeting: 'Hej {person}', extra: 'Extra' };
  const errors = compareCatalogs(english, invalid, 'sv.json');
  assert.ok(errors.some((error) => error.includes('interpolation values differ')));
  assert.ok(errors.some((error) => error.includes('unused message extra')));
  assert.ok(compareCatalogs(english, {}, 'sv.json').some((error) => error.includes('missing message greeting')));
});
