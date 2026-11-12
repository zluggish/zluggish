declare module '@garmin/fitsdk' {
  export interface Stream {
    readonly length: number;
    readonly position: number;
  }
  export const Stream: { fromByteArray(bytes: Uint8Array): Stream };
  export class Decoder {
    constructor(stream: Stream);
    isFIT(): boolean;
    read(options: { convertDateTimesToDates: false; convertTypesToStrings: false }): {
      messages: {
        recordMesgs?: {
          power?: number;
          cadence?: number;
          heartRate?: number;
          distance?: number;
          speed?: number;
          enhancedSpeed?: number;
          timestamp?: number;
          altitude?: number;
          enhancedAltitude?: number;
          positionLat?: number;
          positionLong?: number;
        }[];
        activityMesgs?: { timestamp?: number }[];
      };
      errors: Error[];
    };
  }
}
