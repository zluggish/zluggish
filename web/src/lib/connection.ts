import { t } from './i18n/shared';
import { writable } from 'svelte/store';
import { z } from 'zod';

const jsonObject = z.record(z.string(), z.json());

export type JsonObject = z.output<typeof jsonObject>;

export const connection = writable({ unavailable: false, checking: false, retryIn: 0 });

export class ConnectionError extends Error {
  constructor() {
    super(t('connection_connection_error'));
  }
}

let unavailable = false;
let checking = false;
let failures = 0;
let retryAt = 0;

function publish() {
  connection.set({ unavailable, checking, retryIn: Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) });
}

function disconnected() {
  if (!unavailable) {
    retryAt = Date.now() + 1000;
  }
  unavailable = true;
  publish();
}

/** Never retries a request: a lost mutation response may already have committed. */
export async function request(url: string, init: RequestInit = {}) {
  let response: Response;

  try {
    response = await fetch(url, {
      ...init,
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (init.signal?.aborted) {
      throw error;
    }
    disconnected();
    throw new ConnectionError();
  }

  // A 5xx with the server's own JSON error is an answer with a message, not a lost connection.
  if (response.status >= 500 && !response.headers.get('Content-Type')?.startsWith('application/json')) {
    disconnected();
    throw new ConnectionError();
  }

  return response;
}

export async function requestJson(url: string, init: RequestInit = {}) {
  const response = await request(url, init);

  try {
    // Callers check the shape they read; see decode() in api.ts.
    const body = jsonObject.parse(await response.json());

    return { response, body };
  } catch {
    disconnected();
    throw new ConnectionError();
  }
}

export async function checkConnection() {
  if (checking) {
    return;
  }
  checking = true;
  publish();

  try {
    const response = await fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const healthy = z.object({ name: z.literal('zluggish'), status: z.literal('ok') }).safeParse(await response.json());

    if (!response.ok || !healthy.success) {
      throw new Error(t('unavailable'));
    }
    unavailable = false;
    failures = 0;
    retryAt = Date.now() + 30_000;
  } catch {
    unavailable = true;
    retryAt = Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)) * (0.8 + Math.random() * 0.4);
  } finally {
    checking = false;
    publish();
  }
}

export function monitorConnection() {
  const tick = () => {
    publish();

    if (Date.now() >= retryAt && !document.hidden) {
      void checkConnection();
    }
  };

  const resume = () => {
    void checkConnection();
  };

  const interval = setInterval(tick, 1000);
  window.addEventListener('online', resume);
  window.addEventListener('focus', resume);
  tick();

  return () => {
    clearInterval(interval);
    window.removeEventListener('online', resume);
    window.removeEventListener('focus', resume);
  };
}
