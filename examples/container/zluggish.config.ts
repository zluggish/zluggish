import { defineConfig } from 'zluggish/config';

export default defineConfig(({ env }) => ({
  storageDir: '../storage',
  server: { advertisedIp: '127.0.0.1' },
  network: { host: '0.0.0.0' },
}));
