import { loadRouteNames, titleWithRoute } from '#src/world/route-names';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const assets = fileURLToPath(new URL('../../../assets', import.meta.url));

await test('the route names come from the game info by route id', () => {
  const names = loadRouteNames(assets);

  assert.ok(names.size > 100);
  assert.equal(names.get(10_003), 'Cote de Pike');
  assert.equal(names.get(1), undefined);
});

await test('the route is added to the title of an activity once, and only to a title that exists', () => {
  assert.equal(titleWithRoute('Zwift - Endurance', 'Volcano Circuit'), 'Zwift - Endurance - Volcano Circuit');
  assert.equal(titleWithRoute('Zwift - Volcano Circuit', 'Volcano Circuit'), 'Zwift - Volcano Circuit');
  assert.equal(titleWithRoute('Zwift - Endurance', undefined), 'Zwift - Endurance');
  assert.equal(titleWithRoute('', 'Volcano Circuit'), '');
});
