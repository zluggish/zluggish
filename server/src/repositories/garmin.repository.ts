import { SessionRepository } from '#src/repositories/session.repository';
import { FileTokenStore, Garmin, GarminClient } from 'garminconnect-js';

/** Reuses the existing garth-format OAuth files without invoking Python. */

export class GarminRepository {
  garminClient(tokens: string, domain: string) {
    if (!['garmin.com', 'garmin.cn'].includes(domain)) throw new Error('Unsupported Garmin domain');

    return new GarminClient({
      tokenStore: new FileTokenStore(tokens),
      isCn: domain === 'garmin.cn',
      timeoutMs: 30_000,
      retries: 0,
    });
  }
  async uploadGarmin(tokens: string, domain: string, filename: string, fit: Uint8Array) {
    const client = new GarminRepository().garminClient(tokens, domain);

    if (!(await client.loadTokens())) throw new Error('Authorize Garmin before uploading');
    await new Garmin(client).importActivity(
      new SessionRepository().binaryBlob(fit),
      filename.endsWith('.fit') ? filename : 'activity.fit',
    );
  }
}
