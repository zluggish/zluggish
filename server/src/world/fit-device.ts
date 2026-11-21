import { CrcCalculator } from '@garmin/fitsdk';

/** The device that a FIT file says it was recorded on. */
export interface DeviceIdentity {
  manufacturer: number;
  product: number;
  serial: number;
}

const FILE_ID = 0;
const DEVICE_INFO = 23;

/** The ids of the fields that name the device, in the file_id and the device_info messages. */
const FIELD_IDS = new Map<number, { manufacturer: number; product: number; serial: number }>([
  [FILE_ID, { manufacturer: 1, product: 2, serial: 3 }],
  [DEVICE_INFO, { manufacturer: 2, product: 4, serial: 3 }],
]);

const MAX = { manufacturer: 0xff_ff, product: 0xff_ff, serial: 0xff_ff_ff_ff };

/** Garmin, the manufacturer that Garmin Connect expects for an Edge. */
export const GARMIN_MANUFACTURER = 1;

/** Edge models that a rider can choose, by the product number of the FIT profile. */
export const GARMIN_DEVICES = [
  { product: 3843, name: 'Edge 1040' },
  { product: 4440, name: 'Edge 1050' },
  { product: 3570, name: 'Edge 1030 Plus' },
  { product: 3122, name: 'Edge 830' },
  { product: 3121, name: 'Edge 530' },
  { product: 3558, name: 'Edge 130 Plus' },
  { product: 2713, name: 'Edge 1030' },
  { product: 2909, name: 'Edge 130' },
  { product: 2530, name: 'Edge 820' },
] as const;

/** A serial number of one's own for each rider (FNV-1a of the player id), so that the riders of a server do not share a device. */
export function defaultSerial(player: number) {
  let hash = 0x81_1c_9d_c5;

  for (const char of `zluggish-edge-${player}`) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01_00_01_93);
  }

  return ((hash >>> 0) % 4_000_000_000) + 1;
}

/** The text of garmin_device.txt for a device of Garmin. */
export function deviceText(product: number, serial: number) {
  return `manufacturer=${GARMIN_MANUFACTURER}\nproduct=${product}\nserial=${serial}\n`;
}

/** The lines `manufacturer=1`, `product=3843` and `serial=1234567890` of garmin_device.txt, or null. */
export function parseDeviceIdentity(text: string): DeviceIdentity | null {
  const values = new Map<string, number>();

  for (const line of text.split(/\r?\n/)) {
    const [key, value] = line.split('=', 2);

    if (key && value !== undefined && /^\s*\d+\s*$/.test(value)) {
      values.set(key.trim(), Number(value));
    }
  }

  const manufacturer = values.get('manufacturer');
  const product = values.get('product');
  const serial = values.get('serial');

  if (manufacturer === undefined || product === undefined || serial === undefined) {
    return null;
  }

  if (manufacturer > MAX.manufacturer || product > MAX.product || serial > MAX.serial) {
    return null;
  }

  return { manufacturer, product, serial };
}

interface Definition {
  global: number;
  little: boolean;
  fields: ReadonlyArray<{ id: number; size: number }>;
  /** Bytes of a data message, with the developer fields. */
  size: number;
}

const word = (bytes: Uint8Array, at: number, little: boolean) =>
  little ? (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) : ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);

function store(bytes: Uint8Array, at: number, size: number, value: number, little: boolean) {
  for (let index = 0; index < size; index++) {
    const shift = 8 * (little ? index : size - 1 - index);
    bytes[at + index] = Math.floor(value / 2 ** shift) % 256;
  }
}

/** Write the CRC of the header (when it has one) and of the whole file. */
function sealCrc(bytes: Uint8Array, headerSize: number, end: number) {
  if (headerSize >= 14) {
    const header = CrcCalculator.calculateCRC(bytes, 0, headerSize - 2);
    bytes[headerSize - 2] = header & 0xff;
    bytes[headerSize - 1] = header >> 8;
  }

  const crc = CrcCalculator.calculateCRC(bytes, 0, end);
  bytes[end] = crc & 0xff;
  bytes[end + 1] = crc >> 8;
}

/** Rewrite the manufacturer, product and serial number in every file_id and device_info message, in place,
so that Garmin Connect takes the activity for one recorded on that device. Nothing else changes, and
the CRC is made right again (the game writes a CRC of 0). Returns the file unchanged, with 0 messages
patched, when it is not a FIT file that can be walked to its end.
*/
export function patchDeviceIdentity(fit: Uint8Array, identity: DeviceIdentity) {
  const headerSize = fit[0] ?? 0;
  const dataSize = ((fit[4] ?? 0) | ((fit[5] ?? 0) << 8) | ((fit[6] ?? 0) << 16) | ((fit[7] ?? 0) << 24)) >>> 0;
  const end = headerSize + dataSize;
  const unchanged = { fit, patched: 0 };

  if (headerSize < 12 || end + 2 > fit.length || new TextDecoder().decode(fit.slice(8, 12)) !== '.FIT') {
    return unchanged;
  }

  // Anything after the CRC is dropped, as the game sometimes appends bytes to a finished file.
  const bytes = fit.slice(0, end + 2);
  const definitions: Array<Definition | undefined> = Array.from({ length: 16 });
  let patched = 0;
  let at = headerSize;

  while (at < end) {
    const header = bytes[at++] ?? 0;

    if (header & 0x40 && !(header & 0x80)) {
      // A definition message: reserved byte, architecture, global message number, then the fields.
      const little = bytes[at + 1] === 0;
      const global = word(bytes, at + 2, little);
      const count = bytes[at + 4] ?? 0;
      const fields: Array<{ id: number; size: number }> = [];
      let size = 0;
      at += 5;

      for (let index = 0; index < count; index++) {
        fields.push({ id: bytes[at] ?? 0, size: bytes[at + 1] ?? 0 });
        size += bytes[at + 1] ?? 0;
        at += 3;
      }

      if (header & 0x20) {
        const developer = bytes[at++] ?? 0;

        for (let index = 0; index < developer; index++) {
          size += bytes[at + 1] ?? 0;
          at += 3;
        }
      }

      definitions[header & 0x0f] = { global, little, fields, size };
    } else {
      const local = header & 0x80 ? (header >> 5) & 0x03 : header & 0x0f;
      const definition = definitions[local];

      if (!definition || at + definition.size > end) {
        return unchanged;
      }
      const ids = FIELD_IDS.get(definition.global);

      if (ids) {
        let offset = at;

        for (const field of definition.fields) {
          for (const key of ['manufacturer', 'product', 'serial'] as const) {
            if (field.id === ids[key] && identity[key] < 2 ** (8 * field.size)) {
              store(bytes, offset, field.size, identity[key], definition.little);
            }
          }
          offset += field.size;
        }

        patched++;
      }

      at += definition.size;
    }
  }

  if (at !== end) {
    return unchanged;
  }
  sealCrc(bytes, headerSize, end);

  return { fit: bytes, patched };
}
