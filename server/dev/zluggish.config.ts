import type { ConfigInput } from '../src/config/index.ts';

export default {
  storageDir: '../../storage/dev',
  server: { advertisedIp: '127.0.0.1' },
  network: {
    host: '127.0.0.1',
    api: { port: 8787, useCert: true },
    cdn: { port: 8788 },
    web: { port: 8080, publicUrl: 'http://localhost:5173' },
  },
} satisfies ConfigInput;
