import { SessionRepository } from '#src/repositories/session.repository';
import { AssetFiles } from '#src/repositories/files.repository';
import { resolve } from 'node:path';
import { FileTokenStore, MemoryTokenStore, Garmin, GarminClient } from 'garminconnect-js';

/** Reuses the existing garth-format OAuth files without invoking Python. */

export class GarminRepository {
  garminClient(tokens: string, domain: string, persist = true) {
    if (!['garmin.com', 'garmin.cn'].includes(domain)) throw new Error('Unsupported Garmin domain');

    return new GarminClient({
      tokenStore: persist ? new FileTokenStore(tokens) : new MemoryTokenStore(),
      isCn: domain === 'garmin.cn',
      timeoutMs: 30_000,
      retries: 0,
    });
  }
  /** Authorization stays in memory until the owning browser attempt is validated. */
  saveAuthorization(folder: string, client: GarminClient) {
    const tokens = client.getTokens();

    if (!tokens) throw new Error('Missing Garmin authorization');
    const files = new AssetFiles();
    files.writeDurable(resolve(folder, 'oauth1_token.json'), JSON.stringify(tokens.oauth1), true);
    files.writeDurable(resolve(folder, 'oauth2_token.json'), JSON.stringify(tokens.oauth2), true);
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
