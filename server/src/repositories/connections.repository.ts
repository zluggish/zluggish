import type { ConnectionProvider } from '#src/enum';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { AssetFiles } from '#src/repositories/files.repository';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

export type Connection = ConnectionProvider;

const names: Record<Connection, string> = {
  zwift: 'zwift_credentials.bin',
  intervals: 'intervals_credentials.bin',
  garmin: 'garmin_credentials.bin',
  strava: 'strava_api.bin',
};

export class Connections {
  constructor(readonly storage: string) {}
  private key() {
    const file = resolve(this.storage, 'credentials-key.bin');

    if (!existsSync(file)) new AssetFiles().writeDurable(file, new CryptoRepository().randomBytes(32));
    const key = readFileSync(file);

    if (key.length !== 32) throw new Error('Invalid credentials key');

    return key;
  }
  file(player: number, service: Connection) {
    return resolve(this.storage, String(player), names[service]);
  }
  read(player: number, service: Connection) {
    const file = this.file(player, service);

    return existsSync(file) ? new CryptoRepository().decryptCredentials(this.key(), readFileSync(file)) : null;
  }
  save(player: number, service: Connection, credentials: readonly [string, string]) {
    new AssetFiles().writeDurable(
      this.file(player, service),
      new CryptoRepository().encryptCredentials(this.key(), credentials),
      true,
    );
  }
  remove(player: number, service: Connection) {
    const file = this.file(player, service);

    if (existsSync(file)) unlinkSync(file);
  }
}
