import { openDatabase } from '#src/db/open';
import { migrateAccounts } from '#src/migrations/accounts';
import { SettingsStore } from '#src/repositories/settings.repository';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

for (const upgrade of ['startup', 'accounts migrate'] as const) {
  await test(`${upgrade} removes old account fields and preserves ghost preferences`, async (t) => {
    const storage = mkdtempSync(resolve(tmpdir(), 'zluggish-account-upgrade-'));
    t.after(() => rmSync(storage, { recursive: true, force: true }));
    const db = openDatabase(storage);
    db.exec(`ALTER TABLE user ADD COLUMN remember INTEGER DEFAULT 0;
      ALTER TABLE user ADD COLUMN enable_ghosts INTEGER DEFAULT 1;
      INSERT INTO user (player_id, username, first_name, last_name, is_admin, enable_ghosts)
      VALUES (1, 'first', 'First', 'Rider', 1, 0), (2, 'second', 'Second', 'Rider', 0, 1);
      UPDATE version SET version=4;`);
    db.close();
    const settings = new SettingsStore(storage);
    settings.save(2, { 'ghosts.enabled': false });
    settings.close();

    if (upgrade === 'accounts migrate') await migrateAccounts(storage);
    const reopened = openDatabase(storage);

    const columns = new Set(
      reopened
        .prepare('PRAGMA table_info(user)')
        .all()
        .map((row) => row.name),
    );

    assert.equal(columns.has('remember'), false);
    assert.equal(columns.has('enable_ghosts'), false);
    assert.equal(reopened.prepare('SELECT version FROM version').get()?.version, 5);
    assert.equal(reopened.prepare('SELECT count(*) AS count FROM user').get()?.count, 2);
    reopened.close();
    const persisted = new SettingsStore(storage, true);
    assert.equal(persisted.read(1)['ghosts.enabled'], false);
    assert.equal(persisted.read(2)['ghosts.enabled'], false);
    persisted.close();
  });
}
