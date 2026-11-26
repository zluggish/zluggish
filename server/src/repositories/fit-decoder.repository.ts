import { t } from '#src/i18n/index';
import { Decoder, Stream } from '@garmin/fitsdk';
import { Schema } from 'effect';

const recordSchema = Schema.Struct({
  power: Schema.optional(Schema.Finite),
  cadence: Schema.optional(Schema.Finite),
  heartRate: Schema.optional(Schema.Finite),
  distance: Schema.optional(Schema.Finite),
  speed: Schema.optional(Schema.Finite),
  enhancedSpeed: Schema.optional(Schema.Finite),
  timestamp: Schema.optional(Schema.Finite),
  altitude: Schema.optional(Schema.Finite),
  enhancedAltitude: Schema.optional(Schema.Finite),
  positionLat: Schema.optional(Schema.Finite),
  positionLong: Schema.optional(Schema.Finite),
});

export type ActivityChart = {
  powerInWatts: Array<number>;
  cadencePerMin: Array<number>;
  heartRate: Array<number>;
  distanceInCm: Array<number>;
  speedInCmPerSec: Array<number>;
  timeInSec: Array<number>;
  altitudeInCm: Array<number>;
  latlng: Array<Array<number>>;
};

export type PowerBests = { timestamp: number; bests: Array<{ time: number; power: number }> };

/** Pure FIT computations. The FIT worker and synchronous callers share them. */
export class FitDecoder {
  decode(bytes: Uint8Array) {
    const decoder = new Decoder(Stream.fromByteArray(bytes));

    if (!decoder.isFIT()) {
      throw new Error(t('invalid_fit_activity'));
    }

    const { messages, errors } = decoder.read({
      convertDateTimesToDates: false,
      convertTypesToStrings: false,
    });

    if (errors.length > 0) {
      throw new AggregateError(errors, t('invalid_fit_activity'), { cause: errors[0] });
    }

    return {
      records: Schema.decodeUnknownSync(Schema.Array(recordSchema))(messages.recordMesgs ?? []),
      timestamp:
        messages.activityMesgs?.at(-1)?.timestamp === undefined
          ? Math.floor(Date.now() / 1000)
          : Schema.decodeUnknownSync(Schema.Finite)(messages.activityMesgs.at(-1)?.timestamp) + 631_065_600,
    };
  }

  chart(bytes: Uint8Array): ActivityChart {
    const { records } = this.decode(bytes);

    const data: ActivityChart = {
      powerInWatts: [],
      cadencePerMin: [],
      heartRate: [],
      distanceInCm: [],
      speedInCmPerSec: [],
      timeInSec: [],
      altitudeInCm: [],
      latlng: [],
    };

    let start: number | undefined;
    const step = Math.max(1, Math.floor(records.length / 1000));

    for (let index = 0; index < records.length; index++) {
      const record = records[index];

      if (!record || record.timestamp === undefined) {
        continue;
      }
      start ??= record.timestamp;

      if (index % step) {
        continue;
      }
      const altitude = record.enhancedAltitude ?? record.altitude;
      const speed = record.enhancedSpeed ?? record.speed;

      data.powerInWatts.push(Math.trunc(record.power ?? 0));
      data.cadencePerMin.push(Math.trunc(record.cadence ?? 0));
      data.heartRate.push(Math.trunc(record.heartRate ?? 0));
      data.distanceInCm.push(Math.trunc((record.distance ?? 0) * 100));
      data.speedInCmPerSec.push(Math.trunc((speed ?? 0) * 100));
      data.timeInSec.push(record.timestamp - start);
      data.altitudeInCm.push(Math.trunc((altitude ?? 0) * 100));
      data.latlng.push([
        Number(((record.positionLat ?? 0) / 11_930_465).toFixed(6)),
        Number(((record.positionLong ?? 0) / 11_930_465).toFixed(6)),
      ]);
    }

    return data;
  }

  /** Best average power for the power-curve durations, in whole watts. */
  powerBests(bytes: Uint8Array): PowerBests {
    const { records, timestamp } = this.decode(bytes);
    const power = records.map((record) => Math.trunc(record.power ?? 0));
    const bests = [];

    for (const time of [5, 60, 300, 1200]) {
      if (power.length < time) {
        continue;
      }
      let sum = power.slice(0, time).reduce((total, value) => total + value, 0);
      let best = Math.floor(sum / time);

      for (let index = time; index < power.length; index++) {
        sum += (power[index] ?? 0) - (power[index - time] ?? 0);
        best = Math.max(best, Math.floor(sum / time));
      }

      bests.push({ time, power: best });
    }

    return { timestamp, bests };
  }
}
