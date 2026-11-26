import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeWorkout } from '#src/world/workout-summary';

const Z2_FILE =
  '<?xml version="1.0"?><workout_file><name>Z2 test</name><sportType>bike</sportType><workout>' +
  '<Ramp PowerHigh="0.6" PowerLow="0.48" Duration="600"/>' +
  '<SteadyState PowerHigh="0.62" PowerLow="0.55" Duration="1800"/>' +
  '<SteadyState PowerHigh="0.7" PowerLow="0.65" Duration="600"/>' +
  '<Ramp PowerHigh="0.42" PowerLow="0.55" Duration="600"/>' +
  '</workout></workout_file>';

await test('an hour of Z2 sums up to an hour of four segments in file order', { timeout: 10_000 }, () => {
  const summary = summarizeWorkout(Z2_FILE);

  assert.ok(summary);
  assert.equal(summary.name, 'Z2 test');
  assert.equal(summary.durationSeconds, 3600);
  assert.equal(summary.segments.length, 4);
  assert.deepEqual(summary.segments, [
    { start: 0, duration: 600, from: 0.48, to: 0.6 },
    { start: 600, duration: 1800, from: 0.585, to: 0.585, range: { low: 0.55, high: 0.62 } },
    { start: 2400, duration: 600, from: 0.675, to: 0.675, range: { low: 0.65, high: 0.7 } },
    { start: 3000, duration: 600, from: 0.55, to: 0.42 },
  ]);
  assert.ok(summary.normalizedFraction > 0.55 && summary.normalizedFraction < 0.65);
  assert.ok(Math.abs((summary.zoneSeconds[0] ?? 0) + (summary.zoneSeconds[1] ?? 0) - 3600) < 360);
  assert.equal(
    summary.zoneSeconds.reduce((total, seconds) => total + seconds, 0),
    3600,
  );
  assert.equal(summary.approximate, false);
});

await test('custom zone limits move the steady 0.585 range from zone 2 into zone 1', { timeout: 10_000 }, () => {
  const defaultSummary = summarizeWorkout(Z2_FILE);
  const custom = summarizeWorkout(Z2_FILE, [0.6, 0.8, 0.9, 1.05, 1.2, 1.5]);

  assert.ok(defaultSummary && custom);
  assert.deepEqual(custom.segments, defaultSummary.segments);
  assert.ok((defaultSummary.zoneSeconds[1] ?? 0) > 1800);
  assert.ok((custom.zoneSeconds[0] ?? 0) > (defaultSummary.zoneSeconds[0] ?? 0) + 1800);
  assert.equal(
    custom.zoneSeconds.reduce((total, seconds) => total + seconds, 0),
    3600,
  );
});

await test(
  'zone limits that are not six ascending positive numbers fall back to the default',
  { timeout: 10_000 },
  () => {
    assert.deepEqual(summarizeWorkout(Z2_FILE, [0.55, 0.75])?.zoneSeconds, summarizeWorkout(Z2_FILE)?.zoneSeconds);
    assert.deepEqual(
      summarizeWorkout(Z2_FILE, [0.9, 0.75, 0.55, 1.05, 1.2, 1.5])?.zoneSeconds,
      summarizeWorkout(Z2_FILE)?.zoneSeconds,
    );
  },
);

await test(
  'a SteadyState textevent labels its segment and a Cadence attribute sets its cadence',
  {
    timeout: 10_000,
  },
  () => {
    const summary = summarizeWorkout(
      '<workout_file><sportType>bike</sportType><workout>' +
        '<SteadyState Duration="1800" PowerLow="0.55" PowerHigh="0.62" Cadence="90"><textevent message="Sedno Z2: mozesz rozmawiac caly" duration="10"/></SteadyState>' +
        '</workout></workout_file>',
    );

    assert.ok(summary);
    assert.deepEqual(summary.segments, [
      {
        start: 0,
        duration: 1800,
        from: 0.585,
        to: 0.585,
        range: { low: 0.55, high: 0.62 },
        label: 'Sedno Z2: mozesz rozmawiac caly',
        cadence: 90,
      },
    ]);
  },
);

await test('a step without a textevent has no label', { timeout: 10_000 }, () => {
  const summary = summarizeWorkout(
    '<workout_file><sportType>bike</sportType><workout>' +
      '<SteadyState Power="0.8" Duration="600"/>' +
      '</workout></workout_file>',
  );

  assert.ok(summary);
  assert.deepEqual(summary.segments, [{ start: 0, duration: 600, from: 0.8, to: 0.8 }]);
  assert.ok(!('label' in (summary.segments[0] ?? {})));
});

await test('an IntervalsT labels all six segments and numbers its three repeats', { timeout: 10_000 }, () => {
  const summary = summarizeWorkout(
    '<workout_file><sportType>bike</sportType><workout>' +
      '<IntervalsT Repeat="3" OnDuration="40" OffDuration="20" OnPower="1.05" OffPower="0.5" Cadence="95" CadenceResting="80"><textevent message="BLOK 1"/></IntervalsT>' +
      '</workout></workout_file>',
  );

  assert.ok(summary);
  assert.equal(summary.segments.length, 6);
  for (const [position, segment] of summary.segments.entries()) {
    assert.equal(segment.label, 'BLOK 1');
    assert.deepEqual(segment.interval, { index: Math.floor(position / 2) + 1, count: 3 });
    assert.equal(segment.cadence, position % 2 === 0 ? 95 : 80);
  }
});

await test('an IntervalsT of 3 repeats becomes 6 segments of 540 seconds', { timeout: 10_000 }, () => {
  const summary = summarizeWorkout(
    '<workout_file><sportType>bike</sportType><workout>' +
      '<IntervalsT Repeat="3" OnDuration="60" OffDuration="120" OnPower="1.1" OffPower="0.5"/>' +
      '</workout></workout_file>',
  );

  assert.ok(summary);
  assert.equal(summary.durationSeconds, 540);
  assert.equal(summary.segments.length, 6);
  assert.deepEqual(summary.segments.slice(0, 2), [
    { start: 0, duration: 60, from: 1.1, to: 1.1, interval: { index: 1, count: 3 } },
    { start: 60, duration: 120, from: 0.5, to: 0.5, interval: { index: 1, count: 3 } },
  ]);
  assert.deepEqual(summary.segments[5]?.interval, { index: 3, count: 3 });
  assert.equal(summary.segments[4]?.start, 360);
});

await test('a FreeRide rides at a guessed power and marks the summary approximate', { timeout: 10_000 }, () => {
  const summary = summarizeWorkout(
    '<workout_file><sportType>bike</sportType><workout><FreeRide Duration="600"/></workout></workout_file>',
  );

  assert.ok(summary);
  assert.equal(summary.approximate, true);
  assert.deepEqual(summary.segments, [{ start: 0, duration: 600, from: 0.55, to: 0.55 }]);
});

await test('a running workout is not a cycling workout', { timeout: 10_000 }, () => {
  assert.equal(
    summarizeWorkout(
      '<workout_file><sportType>run</sportType><workout><SteadyState Power="0.7" Duration="600"/></workout></workout_file>',
    ),
    null,
  );
});

await test('garbage text is not a workout', { timeout: 10_000 }, () => {
  assert.equal(summarizeWorkout('totally not xml <<<'), null);
  assert.equal(summarizeWorkout(''), null);
  assert.equal(summarizeWorkout('<workout_file><sportType>bike</sportType><workout></workout></workout_file>'), null);
});

await test('steps keep their file order even when tags interleave', { timeout: 10_000 }, () => {
  const summary = summarizeWorkout(
    '<workout_file><sportType>Cycling</sportType><workout>' +
      '<Ramp PowerLow="0.5" PowerHigh="0.8" Duration="300"/>' +
      '<SteadyState Power="0.9" Duration="300"/>' +
      '<Ramp PowerLow="0.8" PowerHigh="0.5" Duration="300"/>' +
      '</workout></workout_file>',
  );

  assert.ok(summary);
  assert.deepEqual(
    summary.segments.map((segment) => [segment.start, segment.from, segment.to]),
    [
      [0, 0.5, 0.8],
      [300, 0.9, 0.9],
      [600, 0.8, 0.5],
    ],
  );
});
