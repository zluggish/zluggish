import { defineConfig } from 'zluggish/config';

export default defineConfig({
  storageDir: '../storage',
  recovery: { checkpointSeconds: 30, resumeMinutes: 15, maxBytes: 4194304 },
  retention: {
    finishedJobsDays: 14,
    deliveryRecordsDays: 365,
    ghostsPerRoute: 50,
    migrationBackups: 2,
    temporaryFileHours: 24,
  },
  logging: { level: 'INFO', rideProgressIntervalSeconds: 60, metricsIntervalSeconds: 60 },
  server: { advertisedIp: '127.0.0.1' },
  network: { host: '127.0.0.1', api: { port: 8787, useCert: true } },
});
