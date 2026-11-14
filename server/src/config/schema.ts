import { FeatureMode, LogFormat, LogLevelInput, RiderPosition, StravaMethod } from '#src/enum';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';

const unspecifiedAddresses = new BlockList();

unspecifiedAddresses.addAddress('0.0.0.0', 'ipv4');

unspecifiedAddresses.addAddress('::', 'ipv6');

const advertisedIp = z.string().refine((value) => {
  const family = isIP(value);

  return family !== 0 && !unspecifiedAddresses.check(value, family === 4 ? 'ipv4' : 'ipv6');
}, 'Expected a non-wildcard IP address');

const listenerHost = z.string().refine((value) => {
  if (isIP(value)) return true;

  if (/^[\d.]+$/.test(value)) return false;

  if (value.length > 253) return false;

  const labels = (value.endsWith('.') ? value.slice(0, -1) : value).split('.');

  return labels.every((label) => /^[a-z\d_](?:[a-z\d_-]{0,61}[a-z\d_])?$/i.test(label));
}, 'Expected a non-empty IP address or hostname');

const nonEmptyString = z
  .string()
  .refine((value) => value.trim().length > 0 && !value.includes('\0'), 'Expected a non-empty string');

// Empty optional paths select built-in resources or disable the feature.
const optionalPath = z.union([z.literal(''), nonEmptyString]);

export const riderSettingsSchema = z
  .strictObject({
    ghosts: z
      .strictObject({
        enabled: z.boolean().default(false),
      })
      .prefault({})
      .readonly(),
    uploads: z
      .strictObject({
        zwift: z
          .strictObject({
            enabled: z.boolean().default(false),
          })
          .prefault({})
          .readonly(),
        strava: z
          .strictObject({
            method: z.enum(StravaMethod).default('paid'),
          })
          .prefault({})
          .readonly(),
      })
      .prefault({})
      .readonly(),
    devices: z
      .strictObject({
        zwiftClick: z
          .strictObject({
            enabled: z.boolean().default(false),
          })
          .prefault({})
          .readonly(),
      })
      .prefault({})
      .readonly(),
    workouts: z
      .strictObject({
        trainingpeaks: z
          .strictObject({
            bridgeFolder: optionalPath.default(''),
          })
          .prefault({})
          .readonly(),
      })
      .prefault({})
      .readonly(),
  })
  .prefault({})
  .readonly();

export const configSchema = z
  .strictObject({
    server: z
      .strictObject({
        advertisedIp: advertisedIp.default('127.0.0.1'),
      })
      .prefault({})
      .readonly(),
    accounts: z
      .strictObject({
        allowSelfRegistration: z.boolean().default(true),
      })
      .prefault({})
      .readonly(),
    bots: z
      .strictObject({
        enabled: z.boolean().default(false),
        multiplier: z.number().int().safe().min(1).max(100).default(1),
        ridersFile: optionalPath.default(''),
      })
      .prefault({})
      .readonly(),
    proxy: z
      .strictObject({
        mode: z.enum(FeatureMode).default('auto'),
      })
      .prefault({})
      .readonly(),
    dns: z
      .strictObject({
        enabled: z.boolean().default(false),
      })
      .prefault({})
      .readonly(),
    leaderboards: z
      .strictObject({
        allTime: z.boolean().default(false),
      })
      .prefault({})
      .readonly(),
    equipment: z
      .strictObject({
        unlockEntitlements: z.boolean().default(false),
        unlockAll: z.boolean().default(false),
      })
      .prefault({})
      .readonly(),
    ghosts: z
      .strictObject({
        profileFile: optionalPath.default(''),
      })
      .prefault({})
      .readonly(),
    integrations: z
      .strictObject({
        garmin: z
          .strictObject({
            domain: listenerHost.default('garmin.com'),
          })
          .prefault({})
          .readonly(),
        discord: z
          .strictObject({
            enabled: z.boolean().default(false),
            credentialsFile: optionalPath.default(''),
            channel: z.union([z.string().regex(/^\d+$/), z.number().int().safe().min(0)]).default('0'),
            welcomeMessage: z
              .string()
              .refine((v) => !v.includes('\0'), 'Invalid string')
              .default(''),
            helpMessage: z
              .string()
              .refine((v) => !v.includes('\0'), 'Invalid string')
              .default(''),
            announcePlayers: z.boolean().default(false),
          })
          .prefault({})
          .readonly(),
      })
      .prefault({})
      .readonly(),
    logging: z
      .strictObject({
        level: z
          .enum(LogLevelInput)
          .default('INFO')
          .transform((level) => (level === 'DEBUG' ? ('VERBOSE' as const) : level)),
        format: z.enum(LogFormat).default('pretty'),
        rideProgressIntervalSeconds: z
          .number()
          .int()
          .min(0)
          .refine((value) => value === 0 || value >= 10, 'Use 0 or at least 10 seconds')
          .default(60),
      })
      .prefault({})
      .readonly(),
    network: z
      .strictObject({
        host: listenerHost.default('127.0.0.1'),
        cdn: z
          .strictObject({
            host: listenerHost.nullable().default(null),
            port: z.number().int().safe().min(1).max(65_535).default(80),
          })
          .prefault({})
          .readonly(),
        tcp: z
          .strictObject({
            host: listenerHost.nullable().default(null),
            port: z.number().int().safe().min(1).max(65_535).default(3025),
          })
          .prefault({})
          .readonly(),
        udp: z
          .strictObject({
            host: listenerHost.nullable().default(null),
            port: z.number().int().safe().min(1).max(65_535).default(3024),
          })
          .prefault({})
          .readonly(),
        api: z
          .strictObject({
            host: listenerHost.nullable().default(null),
            port: z.number().int().safe().min(1).max(65_535).default(443),
            useCert: z.boolean().default(true),
          })
          .prefault({})
          .readonly(),
      })
      .prefault({})
      .readonly(),
    riderDefaults: riderSettingsSchema,
    storageDir: nonEmptyString.default('../storage'),
    tls: z
      .strictObject({
        certFile: optionalPath.default(''),
        keyFile: optionalPath.default(''),
      })
      .prefault({})
      .readonly(),
    pelotons: z
      .array(
        z
          .strictObject({
            bots: z.number().int().safe().min(0).max(200).default(20),
            columns: z.number().int().safe().min(0).default(0),
            rowGap: z.number().gt(0).default(2.2),
            lateralSpacing: z.number().gt(0).default(65_000),
            besidePacer: z.number().int().safe().min(0).default(2),
            dynamics: z.number().default(1),
            shuffleInterval: z.number().default(30),
            draft: z.number().default(0.7),
            climbStretch: z.number().default(1),
            maxDrop: z.number().default(40),
            pacer: z.union([z.number().int().safe().min(1), nonEmptyString]),
            enabled: z.boolean().default(true),
            riders: z
              .array(
                z
                  .strictObject({
                    countryCode: z.number().int().safe().optional(),
                    bikeFrame: z.number().int().safe().optional(),
                    bikeFrameColour: z.number().int().safe().optional(),
                    bikeWheelFront: z.number().int().safe().optional(),
                    bikeWheelRear: z.number().int().safe().optional(),
                    glassesType: z.number().int().safe().optional(),
                    rideJersey: z.number().int().safe().optional(),
                    rideHelmetType: z.number().int().safe().optional(),
                    rideShoesType: z.number().int().safe().optional(),
                    rideSocksType: z.number().int().safe().optional(),
                    runShirtType: z.number().int().safe().optional(),
                    runShortsType: z.number().int().safe().optional(),
                    runShoesType: z.number().int().safe().optional(),
                    firstName: z
                      .string()
                      .refine((v) => !v.includes('\0'), 'Invalid string')
                      .optional(),
                    lastName: z
                      .string()
                      .refine((v) => !v.includes('\0'), 'Invalid string')
                      .optional(),
                    isMale: z.boolean().optional(),
                    position: z.enum(RiderPosition).optional(),
                    strength: z.number().optional(),
                    weight: z.number().optional(),
                    height: z.number().optional(),
                    cadence: z.number().optional(),
                    maxHeartRate: z.number().optional(),
                  })
                  .prefault({})
                  .readonly(),
              )
              .default([])
              .readonly(),
            id: nonEmptyString,
          })
          .readonly(),
      )
      .default([])
      .readonly(),
    soloBlob: z
      .strictObject({
        enabled: z.boolean().default(false),
        riders: z.number().int().safe().min(0).max(30).default(8),
        rowGap: z.number().gt(0).default(1.8),
        tailGap: z.number().default(4),
        lateralSpacing: z.number().gt(0).default(0.95),
        leadGap: z.number().default(1.6),
        leadLateral: z.number().default(0.8),
        columns: z.number().int().safe().min(0).default(0),
        shuffleInterval: z.number().default(25),
        rotate: z.boolean().default(true),
        pullInterval: z.number().default(60),
        leadSpread: z.number().default(1),
        fullRange: z.boolean().default(false),
        maxLead: z.number().default(8),
        diagInterval: z.number().min(0).default(0),
        latencyComp: z.union([z.number(), z.string().refine((v) => !v.includes('\0'), 'Invalid string')]).default(0),
        formationInterval: z.number().default(45),
        turnInterval: z.number().default(1200),
        rotationRate: z.number().gt(0).default(0.7),
        pullDuration: z.number().default(18),
        passTime: z.number().gt(0).default(18),
        climbStretch: z.number().default(1),
        maxDrop: z.number().default(30),
        hammerTime: z.number().default(180),
        toastTime: z.number().default(120),
        leadTime: z.number().default(120),
        wanderGap: z.number().default(0.3),
        wanderLateral: z.number().default(0.15),
        botGestures: z.boolean().default(true),
        gestureInterval: z.number().default(75),
        gestureChance: z.number().default(1),
        wanderTime: z.number().default(7),
        raggedRows: z.boolean().default(false),
        lateralVia: z
          .string()
          .refine((v) => !v.includes('\0'), 'Invalid string')
          .default('both'),
        lateralScale: z.number().default(1),
        roadHalfWidth: z.number().default(3),
        roadLimits: z
          .string()
          .refine((v) => !v.includes('\0'), 'Invalid string')
          .default('auto'),
        maxRoadShift: z.number().default(4),
        roadAxisLimit: z.number().default(1.5),
        roadAxisSide: z.number().default(-1),
        onlyKitted: z.boolean().default(true),
        scatter: z.boolean().default(true),
        scatterWidth: z.number().default(3),
        scatterGap: z.number().default(1.75),
        scatterSide: z.number().default(1),
        scatterBeside: z.number().default(1),
        keepApartLong: z.number().default(1.75),
        keepApart: z.number().default(0.85),
        playerId: z.number().int().safe().min(1).default(1),
        record: z.boolean().default(false),
      })
      .prefault({})
      .readonly(),
  })
  .readonly();

export type ConfigInput = z.input<typeof configSchema>;

export type ResolvedConfig = z.output<typeof configSchema>;

export type RiderSettings = z.output<typeof riderSettingsSchema>;
