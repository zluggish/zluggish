import { t } from '#src/i18n/index';
import { SecretDocuments } from '#src/enum';
import type { RiderDocumentName } from '#src/enum';
import { query, SqliteExecutor } from '#src/db/query';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { AssetFiles } from '#src/repositories/files.repository';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Schema } from 'effect';

const row = Schema.Struct({ data: Schema.instanceOf(Uint8Array), encrypted: Schema.Finite });

/** Rider state in the main database. Secrets are encrypted with the credentials key,
which stays in a file outside the database: a database backup alone cannot decrypt them.
*/
export class RiderDocuments {
  private readonly executor: SqliteExecutor;

  private readonly crypto = new CryptoRepository();

  constructor(
    readonly db: DatabaseSync,
    readonly storage: string,
  ) {
    this.executor = new SqliteExecutor(db);
  }

  key() {
    const file = resolve(this.storage, 'credentials-key.bin');
    let key: Buffer;

    try {
      if (!existsSync(file)) {
        new AssetFiles().writeDurable(file, this.crypto.randomBytes(32));
      }
      key = readFileSync(file);
    } catch (error) {
      throw new Error(t('rider_document_credentials_key_unavailable', { value1: file }), { cause: error });
    }

    if (key.length !== 32) {
      throw new Error(
        t('rider_document_credentials_key_size_invalid', {
          value1: file,
          value2: key.length,
        }),
      );
    }

    return key;
  }

  get(player: number, name: RiderDocumentName): Uint8Array | null {
    const found = this.executor.get(
      query
        .selectFrom('rider_document')
        .select(['data', 'encrypted'])
        .where('player_id', '=', player)
        .where('name', '=', name),
    );

    if (!found) {
      return null;
    }
    const document = Schema.decodeUnknownSync(row)(found);

    return document.encrypted ? this.crypto.decryptSecret(this.key(), document.data) : document.data;
  }

  text(player: number, name: RiderDocumentName) {
    const data = this.get(player, name);

    return data ? Buffer.from(data).toString('utf8') : null;
  }

  has(player: number, name: RiderDocumentName) {
    return !!this.executor.get(
      query.selectFrom('rider_document').select('name').where('player_id', '=', player).where('name', '=', name),
    );
  }

  put(player: number, name: RiderDocumentName, data: Uint8Array | string) {
    const bytes = data instanceof Uint8Array ? data : Buffer.from(data, 'utf8');
    const encrypted = SecretDocuments.includes(name);
    const stored = encrypted ? this.crypto.encryptSecret(this.key(), bytes) : bytes;

    this.executor.run(
      query
        .insertInto('rider_document')
        .values({ player_id: player, name, data: stored, encrypted: encrypted ? 1 : 0 })
        .onConflict((conflict) =>
          conflict.columns(['player_id', 'name']).doUpdateSet({ data: stored, encrypted: encrypted ? 1 : 0 }),
        ),
    );
  }

  /** Published import stages; a stage publishes once. */
  imported(stage: string) {
    return !!this.executor.get(query.selectFrom('rider_import').select('stage').where('stage', '=', stage));
  }

  recordImport(stage: string, player: number) {
    this.executor.run(query.insertInto('rider_import').values({ stage, player_id: player }));
  }

  remove(player: number, name: RiderDocumentName) {
    return (
      this.executor.run(query.deleteFrom('rider_document').where('player_id', '=', player).where('name', '=', name))
        .changes !== 0
    );
  }
}
