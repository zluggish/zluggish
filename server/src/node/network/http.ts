import { serve } from '@hono/node-server';
import { createServer } from 'node:https';
import type { Hono } from 'hono';

export interface HttpListenerOptions {
  host: string;
  port: number;
  tls?: { cert: Buffer; key: Buffer };
}

export function startHttp(app: Pick<Hono, 'fetch'>, options: HttpListenerOptions) {
  const common = {
    fetch: app.fetch,
    hostname: options.host,
    port: options.port,
  };

  if (options.tls) return serve({ ...common, createServer, serverOptions: options.tls });

  return serve(common);
}
