import { UploadsService } from '#src/services/uploads.service';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const entry = (event: number, name: string, day = '2026-05-01') => ({
  event_id: event,
  name,
  start_date_local: `${day}T07:00:00`,
});

await test('pairing needs a unique workout for the day or an exact unique title', () => {
  const activity = {
    name: 'Tempo',
    startDate: '2026-05-01T06:00:00Z',
    date: '',
  };

  assert.equal(UploadsService.pairedEvent(activity, { collection: false, entries: [entry(7, 'Other')] }), 7);
  assert.equal(
    UploadsService.pairedEvent(activity, {
      collection: true,
      entries: [entry(7, 'Other')],
    }),
    null,
  );
  assert.equal(
    UploadsService.pairedEvent(activity, {
      collection: true,
      entries: [entry(7, 'Other'), entry(8, 'tempo '), entry(9, 'x', '2026-05-02')],
    }),
    8,
  );
  assert.equal(
    UploadsService.pairedEvent(activity, {
      collection: true,
      entries: [entry(8, 'Tempo'), entry(9, 'Tempo')],
    }),
    null,
  );
  assert.equal(
    UploadsService.pairedEvent(
      { name: 'Tempo', startDate: 'garbage', date: '' },
      { collection: false, entries: [entry(7, 'Tempo')] },
    ),
    null,
  );
});
