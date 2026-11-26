import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Option } from 'effect';
import {
  decodeGarminImport,
  garminActivityId,
  decodeIntervalsImport,
  intervalsActivityId,
} from '#src/dtos/remote-ids.dto';
import type { GarminImport, IntervalsImport } from '#src/dtos/remote-ids.dto';

const idOf = (decoded: Option.Option<GarminImport>): string | null =>
  Option.match(decoded, { onNone: () => null, onSome: garminActivityId });

const intervalsIdOf = (decoded: Option.Option<IntervalsImport>): string | null =>
  Option.match(decoded, { onNone: () => null, onSome: intervalsActivityId });

await test('garmin: full upload response returns first success internalId', () => {
  const result = {
    detailedImportResult: {
      uploadId: 1,
      successes: [{ internalId: 123_456_789, externalId: 'x' }],
      failures: [],
    },
  };

  assert.equal(idOf(decodeGarminImport(result)), '123456789');
});

await test('garmin: empty successes returns null', () => {
  const result = {
    detailedImportResult: {
      uploadId: 1,
      successes: [],
      failures: [],
    },
  };

  assert.equal(idOf(decodeGarminImport(result)), null);
});

await test('garmin: empty object returns null', () => {
  assert.equal(idOf(decodeGarminImport({})), null);
});

await test('garmin: null returns null', () => {
  assert.equal(idOf(decodeGarminImport(null)), null);
});

await test('garmin: numeric string internalId is accepted', () => {
  const result = {
    detailedImportResult: {
      uploadId: 1,
      successes: [{ internalId: '987', externalId: 'x' }],
      failures: [],
    },
  };

  assert.equal(idOf(decodeGarminImport(result)), '987');
});

await test('garmin: negative internalId returns null', () => {
  const result = {
    detailedImportResult: {
      uploadId: 1,
      successes: [{ internalId: -5, externalId: 'x' }],
      failures: [],
    },
  };

  assert.equal(idOf(decodeGarminImport(result)), null);
});

await test('garmin: two successes returns the first', () => {
  const result = {
    detailedImportResult: {
      uploadId: 1,
      successes: [
        { internalId: 111, externalId: 'a' },
        { internalId: 222, externalId: 'b' },
      ],
      failures: [],
    },
  };

  assert.equal(idOf(decodeGarminImport(result)), '111');
});

await test('intervals: object with string id', () => {
  assert.equal(intervalsIdOf(decodeIntervalsImport({ id: 'i123456' })), 'i123456');
});

await test('intervals: object with numeric id', () => {
  assert.equal(intervalsIdOf(decodeIntervalsImport({ id: 42 })), '42');
});

await test('intervals: array returns first element id', () => {
  assert.equal(intervalsIdOf(decodeIntervalsImport([{ id: 'i7' }, { id: 'i8' }])), 'i7');
});

await test('intervals: empty array returns null', () => {
  assert.equal(intervalsIdOf(decodeIntervalsImport([])), null);
});

await test('intervals: empty id returns null', () => {
  assert.equal(intervalsIdOf(decodeIntervalsImport({ id: '' })), null);
});

await test('intervals: plain text returns null', () => {
  assert.equal(intervalsIdOf(decodeIntervalsImport('text')), null);
});
