import { AssetFiles } from '#src/repositories/files.repository';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

for (const replace of [false, true]) {
  for (const operation of ['writeFileSync', 'fsyncSync', 'closeSync', 'linkSync', 'renameSync'] as const) {
    if ((operation === 'linkSync' && replace) || (operation === 'renameSync' && !replace)) {
      continue;
    }
    await test(`synchronous publication cleans up after ${operation} fails (replace=${replace})`, (t) => {
      const folder = fs.mkdtempSync(join(tmpdir(), 'publication-'));
      const path = join(folder, 'asset');
      if (replace) {
        fs.writeFileSync(path, 'original');
      }
      const original = fs[operation] as (...args: Array<never>) => void;
      const failure = new Error(operation);
      t.mock.method(fs, operation, (...args: Array<never>) => {
        if (operation === 'closeSync') {
          original(...args);
        }
        throw failure;
      });
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        fs.rmSync(folder, { recursive: true, force: true });
      });

      assert.throws(
        () => new AssetFiles().writeDurable(path, 'replacement', replace),
        (error) => error === failure,
      );
      assert.deepEqual(fs.readdirSync(folder), replace ? ['asset'] : []);
      if (replace) {
        assert.equal(fs.readFileSync(path, 'utf8'), 'original');
      }
    });
  }
}

for (const operation of ['writeFileSync', 'fsyncSync'] as const) {
  await test(`synchronous publication preserves ${operation} failure when close and cleanup also fail`, (t) => {
    const folder = fs.mkdtempSync(join(tmpdir(), 'publication-'));
    const failure = new Error(operation);
    const close = fs.closeSync;
    t.mock.method(fs, operation, () => {
      throw failure;
    });
    const closeMock = t.mock.method(fs, 'closeSync', (fd: number) => {
      close(fd);
      throw new Error('close failed');
    });
    const cleanup = t.mock.method(fs, 'rmSync', () => {
      throw new Error('cleanup failed');
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      fs.rmSync(folder, { recursive: true, force: true });
    });

    assert.throws(
      () => new AssetFiles().writeDurable(join(folder, 'asset'), 'data'),
      (error) => error === failure,
    );
    assert.equal(closeMock.mock.callCount(), 1);
    assert.equal(cleanup.mock.callCount(), 1);
  });
}

await test('synchronous publication syncs contents before publication and the directory afterwards', (t) => {
  const folder = fs.mkdtempSync(join(tmpdir(), 'publication-'));
  const calls: Array<string> = [];
  for (const operation of ['writeFileSync', 'fsyncSync', 'closeSync', 'linkSync', 'unlinkSync', 'rmSync'] as const) {
    const original = fs[operation] as (...args: Array<never>) => void;
    t.mock.method(fs, operation, (...args: Array<never>) => {
      calls.push(operation);
      return original(...args);
    });
  }
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const path = join(folder, 'asset');
  new AssetFiles().writeDurable(path, 'data');
  assert.deepEqual(calls, [
    'writeFileSync',
    'fsyncSync',
    'closeSync',
    'linkSync',
    'unlinkSync',
    ...(process.platform === 'win32' ? [] : ['fsyncSync', 'closeSync']),
    'rmSync',
  ]);
  assert.deepEqual(fs.readdirSync(folder), ['asset']);
  assert.equal(fs.readFileSync(path, 'utf8'), 'data');
});

for (const operation of ['unlinkSync', 'fsyncSync', 'rmSync'] as const) {
  await test(`synchronous publication reports ${operation} failure after publication`, (t) => {
    if (operation === 'fsyncSync' && process.platform === 'win32') {
      return;
    }
    const folder = fs.mkdtempSync(join(tmpdir(), 'publication-'));
    const path = join(folder, 'asset');
    const failure = new Error(operation);
    const original = fs[operation] as (...args: Array<never>) => void;
    let calls = 0;
    t.mock.method(fs, operation, (...args: Array<never>) => {
      calls++;
      if (operation === 'fsyncSync' && calls === 1) {
        return original(...args);
      }
      if (operation === 'rmSync') {
        original(...args);
      }
      throw failure;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      fs.rmSync(folder, { recursive: true, force: true });
    });

    assert.throws(
      () => new AssetFiles().writeDurable(path, 'data'),
      (error) => error === failure,
    );
    assert.deepEqual(fs.readdirSync(folder), ['asset']);
    assert.equal(fs.readFileSync(path, 'utf8'), 'data');
  });
}

await test('synchronous publication leaves an existing destination intact', (t) => {
  const folder = fs.mkdtempSync(join(tmpdir(), 'publication-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'asset');
  fs.writeFileSync(path, 'original');

  assert.throws(() => new AssetFiles().writeDurable(path, 'replacement'), { code: 'EEXIST' });
  assert.deepEqual(fs.readdirSync(folder), ['asset']);
  assert.equal(fs.readFileSync(path, 'utf8'), 'original');
});
