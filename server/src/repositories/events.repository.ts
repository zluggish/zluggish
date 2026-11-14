import { integer } from '#src/db/values';
import type { IntegerInput } from '#src/db/values';
import { query, SqliteExecutor } from '#src/db/query';
import type { DatabaseSync } from 'node:sqlite';

export class EventsRepository {
  private readonly executor: SqliteExecutor;

  constructor(private readonly db: DatabaseSync) {
    this.executor = new SqliteExecutor(db);
  }

  findPrivateEvent(id: IntegerInput) {
    return this.executor.get(query.selectFrom('private_event').select('json').where('id', '=', integer(id)));
  }

  listPrivateEvent() {
    return this.executor.all(query.selectFrom('private_event').select('json').orderBy('id', 'desc').limit(100));
  }

  updatePrivateEvent(json: string, id: IntegerInput) {
    return this.executor.run(query.updateTable('private_event').set({ json }).where('id', '=', integer(id)));
  }

  insertNotification(event: number, player: number, json: string) {
    return this.executor.run(query.insertInto('notification').values({ event_id: event, player_id: player, json }));
  }

  updateNotification(json: string, id: IntegerInput) {
    return this.executor.run(query.updateTable('notification').set({ json }).where('id', '=', integer(id)));
  }

  insertPrivateEvent(json: string) {
    return this.executor.run(query.insertInto('private_event').values({ json }));
  }

  deletePrivateEvent(id: IntegerInput) {
    return this.executor.run(query.deleteFrom('private_event').where('id', '=', integer(id)));
  }

  deleteNotification(event: number) {
    return this.executor.run(query.deleteFrom('notification').where('event_id', '=', event));
  }

  deletePlayerNotification(event: number, player: number) {
    this.executor.run(query.deleteFrom('notification').where('event_id', '=', event).where('player_id', '=', player));
  }

  listNotification(event: number) {
    return this.executor.all(
      query.selectFrom('notification').select(['id', 'player_id', 'json']).where('event_id', '=', event),
    );
  }

  notificationsForPlayer(player: number) {
    return this.executor.all(query.selectFrom('notification').select('json').where('player_id', '=', player));
  }

  findNotification(id: IntegerInput, player: number) {
    return this.executor.get(
      query.selectFrom('notification').select('json').where('id', '=', integer(id)).where('player_id', '=', player),
    );
  }

  begin() {
    this.db.exec('BEGIN IMMEDIATE');
  }

  commit() {
    this.db.exec('COMMIT');
  }

  rollback() {
    this.db.exec('ROLLBACK');
  }
}
