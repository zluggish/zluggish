// Every zluggish setting, showing its default value. Copy only the lines you want to change into your own
// zluggish.config.ts (the file must have that name): anything left out keeps
// its default. Unknown keys and invalid values stop the server at startup. The file is read once; restart after
// editing. Relative paths resolve against the folder that holds this file.
//
// The default export can also be a function, to read environment variables or the config folder:
//   export default defineConfig(({ env, configDir }) => ({ server: { advertisedIp: env.ZLUGGISH_IP ?? '127.0.0.1' } }));
import { defineConfig } from 'zluggish/config';

export default defineConfig({
  // Folder for the database, rider folders, RoboPacers and other server data.
  storageDir: '../storage',

  server: {
    // IP address the game connects to. Must be reachable by the client and cannot be 0.0.0.0 or ::.
    advertisedIp: '127.0.0.1',
  },

  network: {
    // Default listening address for every listener below. '0.0.0.0' listens on all IPv4 interfaces, '::' on IPv6.
    host: '127.0.0.1',

    // Web app: setup, My account and Manage.
    web: {
      enabled: true,
      // Listening address; null uses network.host.
      host: null,
      port: 8080,
      // The address riders open when a reverse proxy sits in front, such as 'https://zluggish.example.com'.
      // Requests are then accepted only from this exact origin, and an https address marks sign-in cookies Secure.
      // No path allowed. null accepts any origin with the request's host and sets Secure only on direct https.
      publicUrl: null,
    },
    // Zwift CDN: bundled game assets and the asset proxy.
    cdn: { host: null, port: 80 },
    // Game connection.
    tcp: { host: null, port: 3025 },
    // Ride data.
    udp: { host: null, port: 3024 },
    // Game app and Zwift API.
    api: {
      host: null,
      port: 443,
      // Serve HTTPS with the certificate from tls below. false serves plain HTTP, for development only.
      useCert: true,
    },
  },

  tls: {
    // Custom certificate and key for the API listener, PEM format. Set both or neither. Empty uses the certificate
    // that the server generates in storage/tls, or the shared zwift.com certificate on a server from before it.
    certFile: '',
    keyFile: '',
    // Lifetime of a certificate that the server generates.
    lifetimeYears: 5,
  },

  dns: {
    // Answer DNS on UDP port 53, so a phone can use this server as "DNS 1" instead of a virtual hosts app.
    enabled: false,
  },

  proxy: {
    // Fetch game assets missing from assets/cdn from Zwift: 'auto', 'enabled' or 'disabled' (local assets only).
    mode: 'auto',
  },

  accounts: {
    // Deprecated and ignored. Only an administrator creates riders, in the web app.
    // allowSelfRegistration: false,
  },

  leaderboards: {
    // Keep all-time results instead of 60 minutes live results and 90 days personal records.
    allTime: false,
  },

  equipment: {
    // Unlock special equipment.
    unlockEntitlements: false,
    // Unlock all equipment. Replaces unlockEntitlements.
    unlockAll: false,
    // Unlock bike upgrades.
    unlockBikeUpgrades: false,
  },

  ghosts: {
    // Legacy ghost appearance file. Kept by migration but not applied yet; playback uses the rider's profile.
    profileFile: '',
  },

  bots: {
    // Ride with recorded bots.
    enabled: false,
    // Copies of each bot, 1 to 100. Large numbers can affect performance.
    multiplier: 1,
    // Catalogue of bot names, nationalities and equipment. Empty uses the built-in list.
    ridersFile: '',
  },

  integrations: {
    garmin: {
      // Garmin Connect domain. Use 'garmin.cn' for a China account.
      domain: 'garmin.com',
    },
    discord: {
      enabled: false,
      // Private file with the bot token and webhook. See the Discord section of the README.
      credentialsFile: '',
      // Channel ID for the chat bridge, as a string.
      channel: '0',
      // Sent when a rider joins. Empty sends nothing.
      welcomeMessage: '',
      // Reply to !help. Empty sends nothing.
      helpMessage: '',
      // Announce riders joining and leaving.
      announcePlayers: false,
    },
    matrix: {
      enabled: false,
      // Private file with the bot password or access token. See the Matrix section of the README.
      credentialsFile: '',
      // Client-server API URL of the homeserver, such as 'https://matrix.example.org'.
      homeserver: '',
      // Bot user, as '@bot:example.org' or just 'bot'.
      user: '',
      // Room ID ('!abc:example.org') or alias ('#ride:example.org'). The room must not be encrypted.
      room: '',
      // Reply to !help. Empty sends nothing.
      helpMessage: '',
      // Announce riders joining and leaving.
      announcePlayers: false,
    },
  },

  logging: {
    // VERBOSE, INFO, WARN, ERROR, CRITICAL or NOTSET. DEBUG and WARNING are accepted as aliases.
    level: 'INFO',
    // Seconds between ride progress lines. 0 turns them off; otherwise at least 10.
    rideProgressIntervalSeconds: 60,
    // Seconds between server metrics lines. 0 turns them off; otherwise at least 10.
    metricsIntervalSeconds: 60,
  },

  recovery: {
    // Seconds between saved snapshots of a ride in progress, at least 5.
    checkpointSeconds: 30,
    // Minutes after a crash or disconnect during which a ride can resume.
    resumeMinutes: 15,
    // Largest snapshot per rider, in bytes, at least 65536.
    maxBytes: 4194304,
  },

  retention: {
    // Days to keep finished background jobs.
    finishedJobsDays: 14,
    // Days to keep upload delivery records.
    deliveryRecordsDays: 365,
    // Ghosts kept per route.
    ghostsPerRoute: 50,
    // Backups kept from storage migrations.
    migrationBackups: 2,
    // Hours before leftover temporary files are removed.
    temporaryFileHours: 24,
  },

  // Starting values for each rider's own settings. Riders change theirs in My account.
  riderDefaults: {
    ghosts: { enabled: true },
    uploads: {
      // Upload finished activities to Intervals.icu when it is connected.
      intervals: { enabled: true },
      // Upload finished activities to Zwift.
      zwift: { enabled: false },
      // Strava upload method: 'paid' or 'free'.
      strava: { method: 'paid' },
    },
    // Pair a Zwift Click controller.
    devices: { zwiftClick: { enabled: false } },
    // Folder the server reads exported TrainingPeaks .zwo files from. Empty turns it off.
    workouts: { trainingpeaks: { bridgeFolder: '' } },
  },

  // RoboPacers followed by a group of bots. Chat command .peloton changes these live; those changes are stored in
  // the database and override this file.
  pelotons: [
    // {
    //   // Stable name for this peloton. Required.
    //   id: 'volcano-group',
    //   // Folder name in storage/robopacers, or the pacer's player ID. Required.
    //   pacer: 'B - 3.3 WKG - Watopia - Volcano Climb',
    //   // false keeps the entry without starting it.
    //   enabled: true,
    //   // Followers, up to 200.
    //   bots: 20,
    //   // Most riders side by side. 0 picks a width.
    //   columns: 0,
    //   // Meters between rows.
    //   rowGap: 2.2,
    //   // Distance between riders side by side, in road units: 100000 is one meter.
    //   lateralSpacing: 65000,
    //   // Riders alongside the pacer.
    //   besidePacer: 2,
    //   // Movement inside the group: 0 rigid, 1 normal, 2 very lively.
    //   dynamics: 1,
    //   // Average seconds between position changes.
    //   shuffleInterval: 30,
    //   // Share of power a rider needs on a wheel.
    //   draft: 0.7,
    //   // How much the group stretches out on climbs.
    //   climbStretch: 1,
    //   // Most meters a weaker rider falls back on a climb.
    //   maxDrop: 40,
    //   // Named riders. The rest get random names and equipment. Every field is optional.
    //   riders: [
    //     {
    //       firstName: 'Ana',
    //       lastName: 'Lopez',
    //       isMale: false,
    //       // Numeric country code, such as 752 for Sweden.
    //       countryCode: 724,
    //       // Where the rider prefers to ride: 'front', 'middle' or 'back'.
    //       position: 'back',
    //       // Relative strength, 0.5 to 1.5.
    //       strength: 0.85,
    //       // Kilograms, centimeters, rpm and beats per minute.
    //       weight: 55,
    //       height: 165,
    //       cadence: 90,
    //       maxHeartRate: 185,
    //       // Equipment by Zwift item ID: bikeFrame, bikeFrameColour, bikeWheelFront, bikeWheelRear, glassesType,
    //       // rideJersey, rideHelmetType, rideShoesType, rideSocksType, runShirtType, runShortsType, runShoesType.
    //     },
    //   ],
    // },
  ],

  // A group of bots that rides around one rider, no RoboPacer needed. Chat command .blob changes these live; those
  // changes are stored in the database and override this file. Distances are in meters, times in seconds.
  soloBlob: {
    // Start the blob for playerId below at server start.
    enabled: false,
    // Player ID of the rider the blob forms around.
    playerId: 1,
    // Riders in the blob, up to 30.
    riders: 8,
    // Use only bots that have a full kit in the catalogue.
    onlyKitted: true,

    // Formation.
    // Most riders side by side behind the leaders. 0 picks a width.
    columns: 0,
    // Gap between rows behind the rider.
    rowGap: 1.8,
    // Length of the group behind the rider.
    tailGap: 4,
    // Distance between riders side by side.
    lateralSpacing: 0.95,
    // Gap between the rider and the bots riding ahead.
    leadGap: 1.6,
    // Sideways offset of the bots riding ahead.
    leadLateral: 0.8,
    // Furthest a bot rides ahead of the rider.
    maxLead: 8,
    // Vary the width of each row.
    raggedRows: false,
    // Place bots loosely around the rider instead of in rows.
    scatter: true,
    // Width of the loose group.
    scatterWidth: 3,
    // Gap between loosely placed bots, front to back.
    scatterGap: 1.75,
    // Gap between loosely placed bots, side to side.
    scatterSide: 1,
    // How close bots ride beside the rider.
    scatterBeside: 1,
    // Smallest gap between two bots, front to back.
    keepApartLong: 1.75,
    // Smallest gap between two bots, side to side. 0 turns it off.
    keepApart: 0.85,

    // Movement.
    // Average seconds between position changes inside the group.
    shuffleInterval: 25,
    // Seconds between reshaping who rides ahead and who behind.
    formationInterval: 45,
    // How many places a bot can move when the group reshapes. 0 keeps the order.
    leadSpread: 1,
    // Let bots move to any place when the group reshapes.
    fullRange: false,
    // Bots take turns at the front, then drift back.
    rotate: true,
    // Average seconds between turns at the front.
    pullInterval: 60,
    // Seconds a bot spends pulling at the front.
    pullDuration: 18,
    // Seconds a bot needs to pass the rider.
    passTime: 18,
    // Meters per second a bot moves forward or back inside the group.
    rotationRate: 0.7,
    // Seconds between the group sending a bot to lead the rider. 0 turns it off.
    turnInterval: 1200,
    // Seconds that bot leads.
    leadTime: 120,
    // How much the group stretches out on climbs.
    climbStretch: 1,
    // Most meters a bot falls back.
    maxDrop: 30,
    // Random drift front to back, and side to side.
    wanderGap: 0.3,
    wanderLateral: 0.15,
    // Seconds for a drift to settle.
    wanderTime: 7,

    // Gestures. Elbow (F1) asks to be passed, Hammertime (F4) goes full gas, I'm toast (F7) eases off, and Bell (F8)
    // asks for a turn in front.
    // Seconds the group rides full gas after Hammertime.
    hammerTime: 180,
    // Seconds the group eases off after I'm toast.
    toastTime: 120,
    // Bots send gestures of their own.
    botGestures: true,
    // Average seconds between bot gestures.
    gestureInterval: 75,
    // Chance a due bot gesture is sent, 0 to 1.
    gestureChance: 1,

    // Road placement. Defaults suit most roads.
    // How sideways offsets are sent: 'both', 'road' (road position) or any other value for map position only.
    lateralVia: 'both',
    // Multiplies every sideways offset, 0.2 to 4.
    lateralScale: 1,
    // Half the road width. 0 turns road limits off.
    roadHalfWidth: 3,
    // 'auto' learns the road edges while riding; 'off' uses roadHalfWidth with roadAxisLimit and roadAxisSide.
    roadLimits: 'auto',
    // Furthest the whole group shifts sideways to stay on the road, up to 4.
    maxRoadShift: 4,
    // With roadLimits 'off': distance allowed past the road center line, and the side it applies to (-1 or 1).
    roadAxisLimit: 1.5,
    roadAxisSide: -1,
    // Seconds to compensate for network delay, or 'auto' to measure it.
    latencyComp: 0,

    // Diagnostics.
    // Write the group's positions to a log file. Chat command .blob record toggles it.
    record: false,
    // Unused.
    diagInterval: 0,
  },
});
