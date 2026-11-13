import { writeDurable } from '#src/repositories/files.repository';
import type { DescMessage } from '@bufbuild/protobuf';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export class StorageRepository {
  constructor(private readonly db: DatabaseSync) {}
  findZfile(...values: SQLInputValue[]) {
    return this.db.prepare('SELECT * FROM zfile WHERE player_id=? AND folder=? AND filename=?').get(...values);
  }
  insertZfile(...values: SQLInputValue[]) {
    return this.db.prepare('INSERT INTO zfile (player_id,folder,filename,timestamp) VALUES (?,?,?,?)').run(...values);
  }
  updateZfileTimestamp(...values: SQLInputValue[]) {
    return this.db.prepare('UPDATE zfile SET timestamp=? WHERE id=?').run(...values);
  }
  listZfile(...values: SQLInputValue[]) {
    return this.db.prepare('SELECT * FROM zfile WHERE player_id=? AND folder=?').all(...values);
  }
  findZfileRow(...values: SQLInputValue[]) {
    return this.db.prepare('SELECT * FROM zfile WHERE id=? AND player_id=?').get(...values);
  }
  deleteZfile(...values: SQLInputValue[]) {
    return this.db.prepare('DELETE FROM zfile WHERE id=?').run(...values);
  }

  readData<Schema extends DescMessage>(schema: Schema, path: string) {
    return existsSync(path) ? fromBinary(schema, readFileSync(path)) : create(schema);
  }
  saveData<Schema extends DescMessage>(schema: Schema, path: string, value: ReturnType<typeof create<Schema>>) {
    writeDurable(path, toBinary(schema, value), true);
  }
  write(path: string, data: Uint8Array) {
    writeDurable(path, data, true);
  }
  read(path: string) {
    return existsSync(path) ? readFileSync(path) : null;
  }
  remove(path: string) {
    if (existsSync(path)) unlinkSync(path);
  }
}
