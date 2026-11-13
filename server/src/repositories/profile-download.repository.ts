import type { ImportFiles } from '#src/dtos/profile-import.dto';
import { EconomyConfigSchema, LoginRequestSchema, LoginResponseSchema } from '#src/protocol/generated/login_pb';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { LoggingRepository } from '#src/repositories/logging.repository';
import { ZwiftRepository, officialRelay } from '#src/repositories/zwift.repository';
import { create, fromBinary, toBinary, toJsonString } from '@bufbuild/protobuf';

/** Download into memory only; the browser must review and publish through ImportsService. */

export class ProfileDownloadRepository {
  constructor(private readonly log = new LoggingRepository()) {}
  async downloadOfficialData(username: string, password: string, profile: boolean, achievements: boolean) {
    const signal = AbortSignal.timeout(30_000);
    const tokens = await new ZwiftRepository().officialTokens(username, password, signal);
    const files: ImportFiles = {};

    const read = async (path: string, body?: Uint8Array) => {
      const response = await fetch(`${officialRelay}/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          ...new ZwiftRepository().officialHeaders(tokens.access_token),
          Accept: 'application/x-protobuf-lite',
          'Content-Type': 'application/x-protobuf-lite',
        },
        body: body ? Buffer.from(body) : null,
        signal,
      });

      if (!response.ok) throw new Error('Official profile download failed');
      const bytes = new Uint8Array(await response.arrayBuffer());

      if (bytes.length > 16 * 1024 * 1024) throw new Error('Official profile download is too large');

      return bytes;
    };

    try {
      if (profile) {
        files['profile.bin'] = await read('api/profiles/me');

        const login = fromBinary(
          LoginResponseSchema,
          await read(
            'api/users/login',
            toBinary(LoginRequestSchema, create(LoginRequestSchema, { key: new CryptoRepository().randomBytes(16) })),
          ),
        );

        if (login.economyConfig)
          files['economy_config.txt'] = Buffer.from(toJsonString(EconomyConfigSchema, login.economyConfig));
      }

      if (achievements) files['achievements.bin'] = await read('api/achievement/loadPlayerAchievements');

      return files;
    } finally {
      if (tokens.refresh_token) {
        try {
          await fetch('https://secure.zwift.com/auth/realms/zwift/tokens/logout', {
            method: 'POST',
            body: new URLSearchParams({ client_id: 'Zwift_Mobile_Link', refresh_token: tokens.refresh_token }),
            signal: AbortSignal.timeout(5000),
          });
        } catch {
          this.log.warn('import.logout_failed', 'Official import session logout failed');
        }
      }
    }
  }
}
