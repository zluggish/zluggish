import { RuntimeContext } from '#src/context';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { GarminRepository } from '#src/repositories/garmin.repository';
import { defaultSerial } from '#src/world/fit-device';
import { DocumentsService } from '#src/services/documents.service';
import { UploadsService } from '#src/services/uploads.service';
import { mediumFixture, mediumWeb } from '#tests/medium/support';
import { Decoder, Stream } from '@garmin/fitsdk';
import { create } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Effect, Schema } from 'effect';

const fit = new Uint8Array(readFileSync(new URL('../fixtures/ride.fit', import.meta.url)));

const activity = create(ActivitySchema, { name: 'Ride', fit, fitFilename: 'ride.fit' });

const named = (bytes: Uint8Array) => {
  const { messages } = new Decoder(Stream.fromByteArray([...bytes])).read({ convertTypesToStrings: false });

  return (messages.fileIdMesgs ?? []).map((message) => [message.manufacturer, message.product]);
};

/** A rider with Garmin authorization; the files that reach Garmin Connect are collected. */
async function garmin(t: TestContext, device?: string, enabled?: boolean) {
  const f = await mediumFixture(t);

  await f.effects.runPromise(
    DocumentsService.use((documents) => documents.put(f.rider.player_id, 'garth/oauth1_token.json', '{}')),
  );

  if (enabled !== undefined) {
    f.settings.save(f.rider.player_id, { 'uploads.garmin.device.enabled': enabled });
  }

  if (device !== undefined) {
    await f.effects.runPromise(
      DocumentsService.use((documents) => documents.put(f.rider.player_id, 'garmin_device.txt', device)),
    );
  }

  const sent: Array<Uint8Array> = [];

  t.mock.method(GarminRepository.prototype, 'uploadGarmin', (...call: Parameters<GarminRepository['uploadGarmin']>) => {
    sent.push(call[3]);

    return Promise.resolve('');
  });

  return { f, sent };
}

await test('the activity reaches Garmin Connect as recorded on the device of garmin_device.txt', async (t) => {
  const { f, sent } = await garmin(t, 'manufacturer=1\nproduct=3843\nserial=1234567890\n', true);

  await f.effects.runPromise(UploadsService.use((uploads) => uploads.garmin(f.rider.player_id, activity)));

  assert.equal(sent.length, 1);
  assert.deepEqual(named(sent[0] ?? new Uint8Array()), [[1, 3843]]);
  assert.deepEqual(activity.fit, fit, 'the activity itself keeps the file of the game');
});

await test('without a device, or with one that cannot be read, the file of the game is sent as it is', async (t) => {
  for (const device of [undefined, 'serial=abc']) {
    const { f, sent } = await garmin(t, device, true);

    await f.effects.runPromise(UploadsService.use((uploads) => uploads.garmin(f.rider.player_id, activity)));
    assert.deepEqual(sent, [fit]);
  }
});

await test('a rider who left the setting at its default gets the file of the game, and keeps the chosen device', async (t) => {
  const { f, sent } = await garmin(t, 'manufacturer=1\nproduct=3843\nserial=1234567890\n');

  await f.effects.runPromise(UploadsService.use((uploads) => uploads.garmin(f.rider.player_id, activity)));

  assert.deepEqual(sent, [fit], 'the device was not written into the file');
  assert.equal(
    f.accounts.repositories.riderDocuments.text(f.rider.player_id, 'garmin_device.txt'),
    'manufacturer=1\nproduct=3843\nserial=1234567890\n',
    'the choice survives turning the setting off',
  );
});

type DeviceInput = Record<string, string | number>;

/** The web app as a signed-in rider: a request with the session, the origin and the CSRF token of a write. */
async function webRider(t: TestContext) {
  const f = await mediumFixture(t);
  const { request } = mediumWeb(f, f.rider);

  const garminSchema = Schema.Struct({
    device: Schema.NullOr(
      Schema.Struct({ manufacturer: Schema.Number, product: Schema.Number, serial: Schema.Number }),
    ),
    devices: Schema.Array(Schema.Struct({ product: Schema.Number, name: Schema.String })),
  });

  const status = async (method: string, path: string, body?: DeviceInput) => {
    const response = await request(path, method, body);

    return response.status;
  };

  const garminState = async () => {
    const response = await request('/api/me/connections/garmin/device');

    return Schema.decodeUnknownSync(garminSchema)(await response.json());
  };

  return { f, status, garminState };
}

await test('a rider chooses the Garmin device in the web app, keeps the serial number, and can remove it', async (t) => {
  const { f, status, garminState } = await webRider(t);
  const player = f.rider.player_id;
  const stored = () => f.accounts.repositories.riderDocuments.text(player, 'garmin_device.txt');
  const path = '/api/me/connections/garmin/device';

  const start = await garminState();
  assert.equal(start.device, null);
  assert.deepEqual(start.devices[0], { product: 3843, name: 'Edge 1040' });
  assert.equal(start.devices.length, 9);

  assert.equal(await status('PUT', path, { product: 3843 }), 200);
  assert.equal(
    stored(),
    `manufacturer=1\nproduct=3843\nserial=${defaultSerial(player)}\n`,
    'a serial number of the rider',
  );
  const chosen = await garminState();
  assert.deepEqual(chosen.device, { manufacturer: 1, product: 3843, serial: defaultSerial(player) });

  await status('PUT', path, { product: 4440, serial: 12_345 });
  assert.equal(stored(), 'manufacturer=1\nproduct=4440\nserial=12345\n');

  await status('PUT', path, { product: 3122 });
  assert.equal(stored(), 'manufacturer=1\nproduct=3122\nserial=12345\n', 'the serial number is kept');

  assert.equal(await status('DELETE', path), 200);
  assert.equal(stored(), null);
  const removed = await garminState();
  assert.equal(removed.device, null);
});

await test('the Garmin device is refused with a product or serial number out of range, or anything else in it', async (t) => {
  const { f, status } = await webRider(t);

  const refused: Array<DeviceInput> = [
    { product: 0 },
    { product: 70_000 },
    { product: 3843, serial: 0 },
    { product: 3843, serial: 4_294_967_296 },
    { product: 3843, manufacturer: 255 },
    { product: 'Edge' },
    {},
  ];

  for (const body of refused) {
    const code = await status('PUT', '/api/me/connections/garmin/device', body);
    assert.equal(code, 400, JSON.stringify(body));
  }

  assert.equal(f.accounts.repositories.riderDocuments.text(f.rider.player_id, 'garmin_device.txt'), null);
});

await test('a file that cannot be given the device is sent as it is, with a warning', async (t) => {
  const { f, sent } = await garmin(t, 'manufacturer=1\nproduct=3843\nserial=1234567890\n', true);
  const warnings: Array<string> = [];
  const broken = create(ActivitySchema, { name: 'Ride', fit: new Uint8Array([1, 2, 3]), fitFilename: 'ride.fit' });

  await f.effects.runPromise(
    Effect.gen(function* () {
      const { world } = yield* RuntimeContext;
      const originalWarn = world.lifecycle.log.warn;

      world.lifecycle.log.warn = (event, message, fields) => {
        warnings.push(message);

        return originalWarn.call(world.lifecycle.log, event, message, fields);
      };

      const uploads = yield* UploadsService;

      yield* uploads.garmin(f.rider.player_id, broken);
    }),
  );

  assert.deepEqual(sent, [new Uint8Array([1, 2, 3])]);
  assert.equal(warnings.length, 1);
});
