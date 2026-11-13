import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export class EventsRepository {
  constructor(private readonly db: DatabaseSync) {}
  findPrivateEvent(...values: SQLInputValue[]) {
    return this.db.prepare('SELECT json FROM private_event WHERE id=?').get(...values);
  }
  listPrivateEvent(...values: SQLInputValue[]) {
    return this.db.prepare('SELECT json FROM private_event ORDER BY id DESC LIMIT 100').all(...values);
  }
  updatePrivateEvent(...values: SQLInputValue[]) {
    return this.db.prepare('UPDATE private_event SET json=? WHERE id=?').run(...values);
  }
  insertNotification(...values: SQLInputValue[]) {
    return this.db.prepare('INSERT INTO notification (event_id,player_id,json) VALUES (?,?,?)').run(...values);
  }
  updateNotification(...values: SQLInputValue[]) {
    return this.db.prepare('UPDATE notification SET json=? WHERE id=?').run(...values);
  }
  insertPrivateEvent(...values: SQLInputValue[]) {
    return this.db.prepare('INSERT INTO private_event (json) VALUES (?)').run(...values);
  }
  deletePrivateEvent(...values: SQLInputValue[]) {
    return this.db.prepare('DELETE FROM private_event WHERE id=?').run(...values);
  }
  deleteNotification(...values: SQLInputValue[]) {
    return this.db.prepare('DELETE FROM notification WHERE event_id=?').run(...values);
  }
  listNotification(...values: SQLInputValue[]) {
    return this.db.prepare('SELECT id,json FROM notification WHERE event_id=?').all(...values);
  }
  notificationsForPlayer(...values: SQLInputValue[]) {
    return this.db.prepare('SELECT json FROM notification WHERE player_id=?').all(...values);
  }
  findNotification(...values: SQLInputValue[]) {
    return this.db.prepare('SELECT json FROM notification WHERE id=? AND player_id=?').get(...values);
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
