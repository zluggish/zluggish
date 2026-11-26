import { t } from '#src/i18n/index';
import { FeatureMode, LogLevelInput, RiderPosition, StravaMethod } from '#src/enum';
import { FiniteAbove, FiniteFrom, IntBetween, NonBlank, satisfies, Text, withDefault } from '#src/schema';
import { Schema, SchemaGetter } from 'effect';
import { BlockList, isIP } from 'node:net';

const unspecifiedAddresses = new BlockList();

unspecifiedAddresses.addAddress('0.0.0.0', 'ipv4');

unspecifiedAddresses.addAddress('::', 'ipv6');

const advertisedIp = Schema.String.check(
  satisfies((value: string) => {
    const family = isIP(value);

    return family !== 0 && !unspecifiedAddresses.check(value, family === 4 ? 'ipv4' : 'ipv6');
  }, t('schema_wildcard_address_invalid')),
);

const listenerHost = Schema.String.check(
  satisfies((value: string) => {
    if (isIP(value)) {
      return true;
    }

    if (/^[\d.]+$/.test(value)) {
      return false;
    }

    if (value.length > 253) {
      return false;
    }

    const labels = (value.endsWith('.') ? value.slice(0, -1) : value).split('.');

    return labels.every((label) => /^[a-z\d_](?:[a-z\d_-]{0,61}[a-z\d_])?$/i.test(label));
  }, t('schema_hostname_required')),
);

const httpUrl = Schema.String.check(
  satisfies(
    (value: string) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol),
    t('schema_http_url_invalid'),
  ),
);

const SafeInt = Schema.Int;

const PositiveInt = IntBetween(1);

const NonNegativeInt = IntBetween(0);

const port = IntBetween(1, 65_535);

const seconds = NonNegativeInt.check(
  satisfies((value: number) => value === 0 || value >= 10, t('schema_interval_invalid')),
);

// Empty optional paths select built-in resources or disable the feature.
const optionalPath = Schema.Union([Schema.Literal(''), NonBlank]);

const optionalHost = Schema.NullOr(listenerHost).pipe(withDefault(null));

/** A strict section whose fields all have defaults: an absent section decodes as `{}`. */
function section<const Fields extends Schema.Struct.Fields>(fields: Fields) {
  const struct = Schema.Struct(fields);

  // SAFETY: every field of a section is optional in its encoded form (a default or an optional key),
  // so the empty object is a valid encoded section.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return struct.pipe(withDefault({} as typeof struct.Encoded));
}

const flag = (value: boolean) => Schema.Boolean.pipe(withDefault(value));

const number = (value: number) => Schema.Finite.pipe(withDefault(value));

const text = (value: string) => Text.pipe(withDefault(value));

export const riderSettingsSchema = section({
  ghosts: section({ enabled: flag(true) }),
  uploads: section({
    intervals: section({ enabled: flag(true) }),
    zwift: section({ enabled: flag(false) }),
    strava: section({ method: Schema.Enum(StravaMethod).pipe(withDefault('paid')) }),
  }),
  devices: section({ zwiftClick: section({ enabled: flag(false) }) }),
  workouts: section({ trainingpeaks: section({ bridgeFolder: optionalPath.pipe(withDefault('')) }) }),
});

const optionalSafeInt = Schema.optional(SafeInt);

const pelotonRider = Schema.Struct({
  countryCode: optionalSafeInt,
  bikeFrame: optionalSafeInt,
  bikeFrameColour: optionalSafeInt,
  bikeWheelFront: optionalSafeInt,
  bikeWheelRear: optionalSafeInt,
  glassesType: optionalSafeInt,
  rideJersey: optionalSafeInt,
  rideHelmetType: optionalSafeInt,
  rideShoesType: optionalSafeInt,
  rideSocksType: optionalSafeInt,
  runShirtType: optionalSafeInt,
  runShortsType: optionalSafeInt,
  runShoesType: optionalSafeInt,
  firstName: Schema.optional(Text),
  lastName: Schema.optional(Text),
  isMale: Schema.optional(Schema.Boolean),
  position: Schema.optional(Schema.Enum(RiderPosition)),
  strength: Schema.optional(Schema.Finite),
  weight: Schema.optional(Schema.Finite),
  height: Schema.optional(Schema.Finite),
  cadence: Schema.optional(Schema.Finite),
  maxHeartRate: Schema.optional(Schema.Finite),
}).pipe(withDefault({}));

const peloton = Schema.Struct({
  bots: IntBetween(0, 200).pipe(withDefault(20)),
  columns: NonNegativeInt.pipe(withDefault(0)),
  rowGap: FiniteAbove(0).pipe(withDefault(2.2)),
  lateralSpacing: FiniteAbove(0).pipe(withDefault(65_000)),
  besidePacer: NonNegativeInt.pipe(withDefault(2)),
  dynamics: number(1),
  shuffleInterval: number(30),
  draft: number(0.7),
  climbStretch: number(1),
  maxDrop: number(40),
  pacer: Schema.Union([PositiveInt, NonBlank]),
  enabled: flag(true),
  riders: Schema.Array(pelotonRider).pipe(withDefault([])),
  id: NonBlank,
});

const logLevel = Schema.Enum(LogLevelInput).pipe(
  Schema.decodeTo(Schema.Literals(['VERBOSE', 'INFO', 'WARNING', 'WARN', 'ERROR', 'CRITICAL', 'NOTSET']), {
    decode: SchemaGetter.transform((level) => (level === 'DEBUG' ? 'VERBOSE' : level)),
    encode: SchemaGetter.passthrough(),
  }),
  withDefault('INFO'),
);

const publicUrl = httpUrl.check(
  satisfies((value: string) => new URL(value).pathname === '/', t('schema_origin_invalid')),
);

export const configSchema = Schema.Struct({
  server: section({ advertisedIp: advertisedIp.pipe(withDefault('127.0.0.1')) }),
  accounts: section({
    /** Deprecated and ignored. Only an administrator creates riders, in the web app. */
    allowSelfRegistration: Schema.optional(Schema.Boolean),
  }),
  bots: section({
    enabled: flag(false),
    multiplier: IntBetween(1, 100).pipe(withDefault(1)),
    ridersFile: optionalPath.pipe(withDefault('')),
  }),
  proxy: section({ mode: Schema.Enum(FeatureMode).pipe(withDefault('auto')) }),
  dns: section({ enabled: flag(false) }),
  leaderboards: section({ allTime: flag(false) }),
  equipment: section({
    unlockEntitlements: flag(false),
    unlockAll: flag(false),
    unlockBikeUpgrades: flag(false),
  }),
  ghosts: section({ profileFile: optionalPath.pipe(withDefault('')) }),
  integrations: section({
    garmin: section({ domain: listenerHost.pipe(withDefault('garmin.com')) }),
    discord: section({
      enabled: flag(false),
      credentialsFile: optionalPath.pipe(withDefault('')),
      channel: Schema.Union([Schema.String.check(Schema.isPattern(/^\d+$/)), NonNegativeInt]).pipe(withDefault('0')),
      welcomeMessage: text(''),
      helpMessage: text(''),
      announcePlayers: flag(false),
    }),
    matrix: section({
      enabled: flag(false),
      credentialsFile: optionalPath.pipe(withDefault('')),
      homeserver: Schema.Union([Schema.Literal(''), httpUrl]).pipe(withDefault('')),
      user: Schema.Union([Schema.Literal(''), Schema.String.check(Schema.isPattern(/^@?[^:\s]+(:\S+)?$/))]).pipe(
        withDefault(''),
      ),
      room: Schema.Union([Schema.Literal(''), Schema.String.check(Schema.isPattern(/^[!#][^:\s]+:\S+$/))]).pipe(
        withDefault(''),
      ),
      helpMessage: text(''),
      announcePlayers: flag(false),
    }),
  }),
  logging: section({
    level: logLevel,
    rideProgressIntervalSeconds: seconds.pipe(withDefault(60)),
    metricsIntervalSeconds: seconds.pipe(withDefault(60)),
  }),
  network: section({
    host: listenerHost.pipe(withDefault('127.0.0.1')),
    web: section({
      enabled: flag(true),
      host: optionalHost,
      port: port.pipe(withDefault(8080)),
      /** The address riders open, when a reverse proxy sits in front. Https here marks cookies Secure. */
      publicUrl: Schema.NullOr(
        publicUrl.pipe(
          Schema.decodeTo(Schema.String, {
            decode: SchemaGetter.transform((value) => new URL(value).origin),
            encode: SchemaGetter.passthrough(),
          }),
        ),
      ).pipe(withDefault(null)),
    }),
    cdn: section({ host: optionalHost, port: port.pipe(withDefault(80)) }),
    tcp: section({ host: optionalHost, port: port.pipe(withDefault(3025)) }),
    udp: section({ host: optionalHost, port: port.pipe(withDefault(3024)) }),
    api: section({
      host: optionalHost,
      port: port.pipe(withDefault(443)),
      useCert: Schema.Literal(true).pipe(withDefault(true)),
    }),
  }),
  riderDefaults: riderSettingsSchema,
  storageDir: NonBlank.pipe(withDefault('../storage')),
  recovery: section({
    checkpointSeconds: IntBetween(5).pipe(withDefault(30)),
    resumeMinutes: PositiveInt.pipe(withDefault(15)),
    maxBytes: IntBetween(65_536).pipe(withDefault(4 * 1024 * 1024)),
  }),
  retention: section({
    finishedJobsDays: PositiveInt.pipe(withDefault(14)),
    deliveryRecordsDays: PositiveInt.pipe(withDefault(365)),
    ghostsPerRoute: PositiveInt.pipe(withDefault(50)),
    migrationBackups: PositiveInt.pipe(withDefault(2)),
    temporaryFileHours: PositiveInt.pipe(withDefault(24)),
  }),
  tls: section({
    certFile: optionalPath.pipe(withDefault('')),
    keyFile: optionalPath.pipe(withDefault('')),
    /** Lifetime of the certificate the server generates for itself. */
    lifetimeYears: IntBetween(1, 20).pipe(withDefault(5)),
  }),
  pelotons: Schema.Array(peloton).pipe(withDefault([])),
  soloBlob: section({
    enabled: flag(false),
    riders: IntBetween(0, 30).pipe(withDefault(8)),
    rowGap: FiniteAbove(0).pipe(withDefault(1.8)),
    tailGap: number(4),
    lateralSpacing: FiniteAbove(0).pipe(withDefault(0.95)),
    leadGap: number(1.6),
    leadLateral: number(0.8),
    columns: NonNegativeInt.pipe(withDefault(0)),
    shuffleInterval: number(25),
    rotate: flag(true),
    pullInterval: number(60),
    leadSpread: number(1),
    fullRange: flag(false),
    maxLead: number(8),
    diagInterval: FiniteFrom(0).pipe(withDefault(0)),
    latencyComp: Schema.Union([Schema.Finite, Text]).pipe(withDefault(0)),
    formationInterval: number(45),
    turnInterval: number(1200),
    rotationRate: FiniteAbove(0).pipe(withDefault(0.7)),
    pullDuration: number(18),
    passTime: FiniteAbove(0).pipe(withDefault(18)),
    climbStretch: number(1),
    maxDrop: number(30),
    hammerTime: number(180),
    toastTime: number(120),
    leadTime: number(120),
    wanderGap: number(0.3),
    wanderLateral: number(0.15),
    botGestures: flag(true),
    gestureInterval: number(75),
    gestureChance: number(1),
    wanderTime: number(7),
    raggedRows: flag(false),
    lateralVia: text('both'),
    lateralScale: number(1),
    roadHalfWidth: number(3),
    roadLimits: text('auto'),
    maxRoadShift: number(4),
    roadAxisLimit: number(1.5),
    roadAxisSide: number(-1),
    onlyKitted: flag(true),
    scatter: flag(true),
    scatterWidth: number(3),
    scatterGap: number(1.75),
    scatterSide: number(1),
    scatterBeside: number(1),
    keepApartLong: number(1.75),
    keepApart: number(0.85),
    playerId: PositiveInt.pipe(withDefault(1)),
    record: flag(false),
  }),
});

export type ConfigInput = typeof configSchema.Encoded;

export type ResolvedConfig = typeof configSchema.Type;

export type RiderSettings = typeof riderSettingsSchema.Type;
