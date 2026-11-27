import { t } from '#src/i18n/index';
import { Schema } from 'effect';

const signingKeys = Schema.Struct({
  keys: Schema.Array(Schema.Struct({ kid: Schema.String, kty: Schema.String, n: Schema.String, e: Schema.String })),
});

export type AccessSigningKey = (typeof signingKeys.Type)['keys'][number];

/** Reads a Cloudflare Access team's published signing keys. */
export class CloudflareAccessRepository {
  async keys(teamDomain: string): Promise<ReadonlyArray<AccessSigningKey>> {
    const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(t('access_keys_unavailable', { value1: response.status }));
    }

    return Schema.decodeUnknownSync(signingKeys)(await response.json()).keys;
  }
}
