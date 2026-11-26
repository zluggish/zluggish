import { t } from '#src/i18n/index';
import { DeliveryRefusedError, refused } from '#src/errors';
import type { RiderDocuments } from '#src/repositories/rider-document.repository';
import { SessionRepository } from '#src/repositories/session.repository';
import { decodeGarminImport, garminActivityId } from '#src/dtos/remote-ids.dto';
import type { OAuth1Token, TokenStore, Tokens } from 'garminconnect-js';
import { Garmin, GarminAuthError, GarminClient, GarminHttpError, MemoryTokenStore } from 'garminconnect-js';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Option, Schema } from 'effect';

const oauth1 = Schema.Struct({
  oauth_token: Schema.String,
  oauth_token_secret: Schema.String,
  // Python garth writes absent optional fields as null.
  mfa_token: Schema.optional(Schema.NullOr(Schema.String)),
  mfa_expiration_timestamp: Schema.optional(Schema.NullOr(Schema.String)),
  domain: Schema.optional(Schema.NullOr(Schema.String)),
});

function oauth1Token(text: string) {
  const parsed = Schema.decodeUnknownSync(oauth1)(JSON.parse(text));
  const token: OAuth1Token = { oauth_token: parsed.oauth_token, oauth_token_secret: parsed.oauth_token_secret };

  if (parsed.mfa_token !== undefined && parsed.mfa_token !== null) {
    token.mfa_token = parsed.mfa_token;
  }

  if (parsed.mfa_expiration_timestamp !== undefined && parsed.mfa_expiration_timestamp !== null) {
    token.mfa_expiration_timestamp = parsed.mfa_expiration_timestamp;
  }

  if (parsed.domain !== undefined && parsed.domain !== null) {
    token.domain = parsed.domain;
  }

  return token;
}

const oauth2 = Schema.Struct({
  scope: Schema.String,
  jti: Schema.String,
  token_type: Schema.String,
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Finite,
  refresh_token_expires_in: Schema.Finite,
  expires_at: Schema.Finite,
  refresh_token_expires_at: Schema.Finite,
});

/** garth-format tokens, kept as encrypted rider documents. */
class DocumentTokenStore implements TokenStore {
  constructor(
    private readonly documents: RiderDocuments,
    private readonly player: number,
  ) {}

  load(): Promise<Tokens | null> {
    return Promise.try(() => {
      const first = this.documents.text(this.player, 'garth/oauth1_token.json');
      const second = this.documents.text(this.player, 'garth/oauth2_token.json');

      return first && second
        ? { oauth1: oauth1Token(first), oauth2: Schema.decodeUnknownSync(oauth2)(JSON.parse(second)) }
        : null;
    });
  }

  save(tokens: Tokens) {
    return Promise.try(() => {
      this.documents.put(this.player, 'garth/oauth1_token.json', JSON.stringify(tokens.oauth1));
      this.documents.put(this.player, 'garth/oauth2_token.json', JSON.stringify(tokens.oauth2));
    });
  }

  clear() {
    return Promise.try(() => {
      this.documents.remove(this.player, 'garth/oauth1_token.json');
      this.documents.remove(this.player, 'garth/oauth2_token.json');
    });
  }
}

export class GarminRepository {
  tokenStore(documents: RiderDocuments, player: number): TokenStore {
    return new DocumentTokenStore(documents, player);
  }

  garminClient(store: TokenStore | null, domain: string) {
    if (!['garmin.com', 'garmin.cn'].includes(domain)) {
      throw new Error(t('unsupported_garmin_domain'));
    }

    return new GarminClient({
      tokenStore: store ?? new MemoryTokenStore(),
      isCn: domain === 'garmin.cn',
      timeoutMs: 30_000,
      retries: 0,
    });
  }

  /** Authorization stays in memory until the owning browser attempt is validated. */
  async saveAuthorization(store: TokenStore, client: GarminClient) {
    const tokens = client.getTokens();

    if (!tokens) {
      throw new Error(t('missing_garmin_authorization'));
    }
    await store.save(tokens);
  }

  /** Garmin rejects a duplicate import with 409: the activity is already there. */
  async uploadGarmin(store: TokenStore, domain: string, filename: string, fit: Uint8Array): Promise<string | null> {
    const client = this.garminClient(store, domain);

    if (!(await client.loadTokens())) {
      throw new DeliveryRefusedError({ code: 'garmin_unauthorized' });
    }

    try {
      const result = await new Garmin(client).importActivity(
        new SessionRepository().binaryBlob(fit),
        filename.endsWith('.fit') ? filename : 'activity.fit',
      );

      return Option.match(decodeGarminImport(result), { onNone: () => null, onSome: garminActivityId });
    } catch (error) {
      const http = error instanceof GarminHttpError ? error : error instanceof Error ? error.cause : null;

      if (http instanceof GarminHttpError && http.status === 409) {
        return null;
      }

      if (http instanceof GarminHttpError && refused(http.status)) {
        throw new DeliveryRefusedError({ code: `garmin_${http.status}` });
      }

      if (error instanceof GarminAuthError) {
        throw new DeliveryRefusedError({ code: 'garmin_unauthorized' });
      }
      throw error;
    }
  }

  /** The photos of a ride, one request each, added to an activity Garmin already imported. */
  async postActivityImages(store: TokenStore, domain: string, activityId: string, photos: ReadonlyArray<string>) {
    const client = this.garminClient(store, domain);

    if (!(await client.loadTokens())) {
      throw new DeliveryRefusedError({ code: 'garmin_unauthorized' });
    }

    for (const photo of photos) {
      await client.upload(
        new Blob([readFileSync(photo)], { type: 'image/jpeg' }),
        basename(photo),
        `/activity-service/activity/${activityId}/image`,
      );
    }
  }
}
