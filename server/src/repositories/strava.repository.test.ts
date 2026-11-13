import { parseForm } from '#src/repositories/strava.repository';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('free Strava edit forms are parsed with checked boxes, selects and escaped values', () => {
  assert.deepEqual(
    parseForm(
      `<input name="a" value="x&amp;y"><input name="off" type="checkbox" value="1"><input name="on" type="checkbox" checked><input type="submit" name="go" value="Go"><select name="s"><option value="1">A</option><option value="2" selected>B</option></select><textarea name="t">hi &lt;b&gt;</textarea>`,
    ),
    { a: 'x&y', on: '1', s: '2', t: 'hi <b>' },
  );
});
