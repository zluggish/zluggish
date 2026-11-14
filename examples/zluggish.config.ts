import { defineConfig } from 'zluggish/config';

export default defineConfig({
  storageDir: '../storage',
  logging: { level: 'INFO', format: 'pretty', rideProgressIntervalSeconds: 60 },
  server: { advertisedIp: '127.0.0.1' },
  network: { host: '127.0.0.1', api: { port: 8787, useCert: false } },
});
