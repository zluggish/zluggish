import { GarminClient, Garmin, FileTokenStore } from 'garminconnect-js';
import { binaryBlob } from '#src/node/integrations/session';

/** Reuses the existing garth-format OAuth files without invoking Python. */
export function garminClient(tokens: string, domain: string) {
  if (!['garmin.com', 'garmin.cn'].includes(domain)) throw new Error('Unsupported Garmin domain');

  return new GarminClient({
    tokenStore: new FileTokenStore(tokens),
    isCn: domain === 'garmin.cn',
    timeoutMs: 30_000,
    retries: 0,
  });
}

export async function uploadGarmin(tokens: string, domain: string, filename: string, fit: Uint8Array) {
  const client = garminClient(tokens, domain);

  if (!(await client.loadTokens())) throw new Error('Authorize Garmin before uploading');
  await new Garmin(client).importActivity(binaryBlob(fit), filename.endsWith('.fit') ? filename : 'activity.fit');
}
