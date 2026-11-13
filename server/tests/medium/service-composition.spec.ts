import { BaseService } from '#src/services/base.service';
import { mediumFixture } from '#tests/medium/support';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('all services share the runtime repositories and profile state', async (t) => {
  const f = await mediumFixture(t);
  const repositories = f.accounts.repositories;

  for (const service of Object.values(f.services)) {
    assert.ok(service instanceof BaseService);
    assert.equal(service.repositories, repositories);
  }

  assert.equal(repositories.profileRepository, f.profiles);
  assert.equal(repositories.settingsRepository, f.settings);
  assert.equal(repositories.accountsRepository, f.accounts.repository);
});
