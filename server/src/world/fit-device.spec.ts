import { defaultSerial, deviceText, parseDeviceIdentity, patchDeviceIdentity } from '#src/world/fit-device';
import { Decoder, Encoder, Stream } from '@garmin/fitsdk';
import type { DeviceInfoMesg, FileIdMesg, RecordMesg } from '@garmin/fitsdk';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const fit = new Uint8Array(readFileSync(new URL('../../tests/fixtures/ride.fit', import.meta.url)));

/** The numbers of the messages in the FIT profile. */
const FILE_ID = 0;

const DEVICE_INFO = 23;

const RECORD = 20;

const edge = { manufacturer: 1, product: 3843, serial: 1_234_567_890 };

const decode = (bytes: Uint8Array) => {
  const decoder = new Decoder(Stream.fromByteArray([...bytes]));
  const sound = decoder.isFIT() && decoder.checkIntegrity();
  const { messages, errors } = new Decoder(Stream.fromByteArray([...bytes])).read({ convertTypesToStrings: false });

  return { sound, errors, messages };
};

const identities = (bytes: Uint8Array) => {
  const { messages } = decode(bytes);

  return [
    ...(messages.fileIdMesgs ?? []).map((message) => [message.manufacturer, message.product, message.serialNumber]),
    ...(messages.deviceInfoMesgs ?? []).map((message) => [message.manufacturer, message.product, message.serialNumber]),
  ];
};

await test('the device of garmin_device.txt is read, and anything incomplete or out of range is not', () => {
  assert.deepEqual(parseDeviceIdentity('manufacturer=1\nproduct=3843\nserial=1234567890\n'), edge);
  assert.deepEqual(parseDeviceIdentity('serial=1234567890\r\nproduct = 3843\r\nmanufacturer= 1'), edge);
  assert.equal(parseDeviceIdentity('manufacturer=1\nproduct=3843'), null, 'no serial number');
  assert.equal(parseDeviceIdentity('manufacturer=1\nproduct=3843\nserial=abc'), null);
  assert.equal(parseDeviceIdentity('manufacturer=70000\nproduct=3843\nserial=1'), null, 'a manufacturer is 16 bits');
  assert.equal(parseDeviceIdentity('manufacturer=1\nproduct=3843\nserial=4294967296'), null, 'a serial is 32 bits');
  assert.equal(parseDeviceIdentity(''), null);
});

/** A file like the game writes: a file_id and a device_info that both name a device with a serial number. */
const withDevice = () => {
  const encoder = new Encoder();
  const timeCreated = new Date(Date.UTC(2026, 10, 1));

  const fileId: FileIdMesg = {
    type: 'activity',
    manufacturer: 'development',
    product: 7,
    serialNumber: 111,
    timeCreated,
  };

  const deviceInfo: DeviceInfoMesg = {
    timestamp: timeCreated,
    deviceIndex: 0,
    manufacturer: 'development',
    product: 7,
    serialNumber: 111,
  };

  const record: RecordMesg = { timestamp: timeCreated, heartRate: 140, power: 200 };

  encoder.onMesg(FILE_ID, fileId);
  encoder.onMesg(DEVICE_INFO, deviceInfo);
  encoder.onMesg(RECORD, record);

  return encoder.close();
};

await test('the manufacturer, product and serial are rewritten in file_id and device_info, nothing else changes', () => {
  const original = withDevice();
  const before = decode(original);
  const { fit: patched, patched: count } = patchDeviceIdentity(original, edge);
  const after = decode(patched);

  assert.equal(count, 2, 'the file_id and the device_info were patched');
  assert.deepEqual(identities(original), [
    [255, 7, 111],
    [255, 7, 111],
  ]);
  assert.deepEqual(identities(patched), [
    [1, 3843, 1_234_567_890],
    [1, 3843, 1_234_567_890],
  ]);
  assert.equal(after.sound, true, 'the file is valid and its CRC is right');
  assert.deepEqual(after.errors, []);
  assert.deepEqual(after.messages.recordMesgs, before.messages.recordMesgs, 'the records of the ride are the same');
  assert.equal(patched.length, original.length);
});

await test('a file whose file_id has no serial number gets the manufacturer and product', () => {
  const { fit: patched, patched: count } = patchDeviceIdentity(fit, edge);
  const after = decode(patched);

  assert.equal(count, 1);
  assert.deepEqual(
    after.messages.fileIdMesgs?.map((message) => [message.manufacturer, message.product]),
    [[1, 3843]],
  );
  assert.equal(after.sound, true);
  assert.deepEqual(after.messages.recordMesgs, decode(fit).messages.recordMesgs);
});

await test('each rider gets a serial number of their own, always the same', () => {
  const serials = [1, 2, 3, 12_345_678].map((player) => defaultSerial(player));

  assert.equal(new Set(serials).size, serials.length);
  assert.ok(serials.every((serial) => serial >= 1 && serial <= 4_000_000_000));
  assert.deepEqual(
    [1, 2, 3, 12_345_678].map((player) => defaultSerial(player)),
    serials,
  );
  assert.equal(deviceText(3843, 7), 'manufacturer=1\nproduct=3843\nserial=7\n');
  assert.deepEqual(parseDeviceIdentity(deviceText(3843, 7)), { manufacturer: 1, product: 3843, serial: 7 });
});

await test('patching twice gives the same file, and the file given is not changed', () => {
  const original = fit.slice();
  const once = patchDeviceIdentity(fit, edge).fit;

  assert.deepEqual(patchDeviceIdentity(once, edge).fit, once);
  assert.deepEqual(fit, original);
});

await test('bytes after the end of the file are dropped, and a file that cannot be walked is left as it is', () => {
  const longer = new Uint8Array([...fit, 1, 2, 3]);
  assert.equal(patchDeviceIdentity(longer, edge).fit.length, fit.length);

  const cut = fit.slice(0, -20);
  assert.deepEqual(patchDeviceIdentity(cut, edge), { fit: cut, patched: 0 });

  const text = new TextEncoder().encode('this is not a FIT file at all, only some text');
  assert.deepEqual(patchDeviceIdentity(text, edge), { fit: text, patched: 0 });
  assert.equal(patchDeviceIdentity(new Uint8Array(), edge).patched, 0);
});
