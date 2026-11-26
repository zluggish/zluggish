import { t } from '#src/i18n/index';
import { Schema } from 'effect';

export const officialRelay = 'https://us-or-rly101.zwift.com';

export class ZwiftRepository {
  async officialTokens(username: string, password: string, signal = AbortSignal.timeout(30_000)) {
    const response = await fetch('https://secure.zwift.com/auth/realms/zwift/tokens/access/codes', {
      method: 'POST',
      headers: {
        'User-Agent': 'Zwift/1.5 (iPhone; iOS 9.0.2; Scale/2.00)',
        'Accept-Language': 'en-US;q=1',
      },
      body: new URLSearchParams({
        client_id: 'Zwift_Mobile_Link',
        username,
        password,
        grant_type: 'password',
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(t('zwift_login_was_rejected'));
    }

    return Schema.decodeUnknownSync(
      Schema.Struct({ access_token: Schema.String, refresh_token: Schema.optional(Schema.String) }),
    )(await response.json());
  }

  async officialLogin(username: string, password: string) {
    const tokens = await new ZwiftRepository().officialTokens(username, password);

    return tokens.access_token;
  }

  officialHeaders = (token: string) => ({
    Authorization: t('zwift_bearer', { value1: token }),
    'User-Agent': 'Zwift/115 CFNetwork/758.0.2 Darwin/15.0.0',
    'Accept-Language': 'en-us',
  });
}
