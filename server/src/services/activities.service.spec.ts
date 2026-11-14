import { ApplicationError } from '#src/errors';
import { ActivitySchema, FitnessPrivacy } from '#src/protocol/generated/activity_pb';
import { ActivityPrivacyType } from '#src/protocol/generated/profile_pb';
import { ActivitiesService } from '#src/services/activities.service';
import { clone, create } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const service = ActivitiesService.prototype;

await test('owners retain access while other riders can only see public activities', () => {
  for (const privacy of [ActivityPrivacyType.PUBLIC, ActivityPrivacyType.PRIVATE, ActivityPrivacyType.FRIENDS]) {
    for (const privateActivity of [false, true]) {
      const activity = create(ActivitySchema, {
        playerId: 1n,
        privacy,
        privateActivity,
        fitnessPrivacy: FitnessPrivacy.HIDE_SENSITIVE_DATA,
      });

      assert.equal(service.forViewer(activity, 1), activity);
      assert.equal(service.fitnessVisible(activity, 1), true);

      if (privacy === ActivityPrivacyType.PUBLIC && !privateActivity) {
        assert.equal(service.visible(activity, 2), true);
      } else {
        assert.equal(service.visible(activity, 2), false);
        assert.equal(service.fitnessVisible(activity, 2), false);
        assert.throws(() => service.forViewer(activity, 2), new ApplicationError(404));
      }
    }
  }
});

await test('public summaries strip sensitive and unknown fields without changing the saved activity', () => {
  const summary = {
    id: 9n,
    playerId: 1n,
    courseId: 6n,
    sport: 0,
    date: '2026-11-14T09:00:00Z',
    name: 'Morning ride',
    startDate: '2026-11-14T08:00:00Z',
    endDate: '2026-11-14T09:00:00Z',
    distanceInMeters: 30_000,
    totalElevation: 100,
    movingTimeInMs: 3_600_000n,
    privacy: ActivityPrivacyType.PUBLIC,
    fitnessPrivacy: FitnessPrivacy.HIDE_SENSITIVE_DATA,
  };

  const activity = create(ActivitySchema, {
    ...summary,
    avgHeartRate: 150,
    maxHeartRate: 180,
    avgWatts: 200,
    calories: 600,
    fit: new Uint8Array([1, 2, 3]),
    fitFilename: 'private.fit',
  });

  activity.$unknown = [{ no: 999, wireType: 2, data: new Uint8Array([1, 42]) }];
  const snapshot = clone(ActivitySchema, activity);

  assert.equal(service.fitnessVisible(activity, 2), false);
  assert.deepEqual(service.forViewer(activity, 2), create(ActivitySchema, summary));
  assert.deepEqual(activity, snapshot);
});

await test('public activities expose fitness data when permitted by fitness privacy', () => {
  for (const fitnessPrivacy of [FitnessPrivacy.UNSET, FitnessPrivacy.SAME_AS_ACTIVITY]) {
    const activity = create(ActivitySchema, { playerId: 1n, avgWatts: 250, fitnessPrivacy });
    assert.equal(service.fitnessVisible(activity, 2), true);
    assert.equal(service.forViewer(activity, 2), activity);
  }
});
