import { query, SqliteExecutor } from '#src/db/query';
import { integer } from '#src/db/values';
import type { DatabaseSync } from 'node:sqlite';

export class StorageRepository {
  private readonly executor: SqliteExecutor;
  constructor(db: DatabaseSync) {
    this.executor = new SqliteExecutor(db);
  }
  findZfile(player: number, folder: string, filename: string) {
    return this.executor.get(
      query
        .selectFrom('zfile')
        .selectAll()
        .where('player_id', '=', player)
        .where('folder', '=', folder)
        .where('filename', '=', filename),
    );
  }
  insertZfile(player: number, folder: string, filename: string, timestamp: number) {
    return this.executor.run(query.insertInto('zfile').values({ player_id: player, folder, filename, timestamp }));
  }
  updateZfileTimestamp(timestamp: number, id: number) {
    return this.executor.run(query.updateTable('zfile').set({ timestamp }).where('id', '=', id));
  }
  listZfile(player: number, folder: string) {
    return this.executor.all(
      query.selectFrom('zfile').selectAll().where('player_id', '=', player).where('folder', '=', folder),
    );
  }
  findZfileRow(id: string, player: number) {
    return this.executor.get(
      query.selectFrom('zfile').selectAll().where('id', '=', integer(id)).where('player_id', '=', player),
    );
  }
  deleteZfile(id: number) {
    return this.executor.run(query.deleteFrom('zfile').where('id', '=', id));
  }
}
