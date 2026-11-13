import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export class ActivitiesRepository {
  constructor(private readonly db: DatabaseSync) {}
  listActivityImage(...values: SQLInputValue[]) {
    return this.db.prepare('SELECT id FROM activity_image WHERE player_id=? AND activity_id=?').all(...values);
  }
  listActivityMedia(...values: SQLInputValue[]) {
    return this.db
      .prepare('SELECT id, content_type FROM activity_media WHERE player_id=? AND activity_id=?')
      .all(...values);
  }
  findActivity(...values: SQLInputValue[]) {
    return this.db.prepare('SELECT id FROM activity WHERE id=? AND player_id=?').get(...values);
  }
  deleteActivity(...values: SQLInputValue[]) {
    return this.db.prepare('DELETE FROM activity WHERE id=? AND player_id=?').run(...values);
  }
  deleteActivityById(...values: SQLInputValue[]) {
    return this.db.prepare('DELETE FROM activity WHERE id=?').run(...values);
  }
  findActivityFile(...values: SQLInputValue[]) {
    return this.db.prepare('SELECT id FROM activity_file WHERE activity_id=? AND full=0').get(...values);
  }
  insertActivityFile(...values: SQLInputValue[]) {
    return this.db.prepare('INSERT INTO activity_file (activity_id,full) VALUES (?,0)').run(...values);
  }
  findOwnedActivityFile(...values: SQLInputValue[]) {
    return this.db.prepare('SELECT id FROM activity_file WHERE id=? AND activity_id=?').get(...values);
  }
  insertActivityImage(...values: SQLInputValue[]) {
    return this.db.prepare('INSERT INTO activity_image (player_id,activity_id) VALUES (?,?)').run(...values);
  }
  insertActivityMedia(...values: SQLInputValue[]) {
    return this.db
      .prepare('INSERT INTO activity_media (player_id,activity_id,content_type) VALUES (?,?,?)')
      .run(...values);
  }
  findActivityMedia(...values: SQLInputValue[]) {
    return this.db.prepare('SELECT * FROM activity_media WHERE id=?').get(...values);
  }

  recentActivities(...values: SQLInputValue[]) {
    const query = this.db.prepare(
      "SELECT * FROM activity WHERE player_id=? AND date > date('now', '-1 month') ORDER BY id",
    );

    query.setReadBigInts(true);

    return query.all(...values);
  }

  activityById(...values: SQLInputValue[]) {
    const query = this.db.prepare('SELECT * FROM activity WHERE id=?');
    query.setReadBigInts(true);

    return query.get(...values);
  }

  activityFeed(...values: SQLInputValue[]) {
    const query = this.db.prepare(
      'SELECT * FROM activity WHERE distanceInMeters>1 AND (? IS NULL OR player_id=?) AND (? IS NULL OR id<?) AND (? OR end_date IS NOT NULL) ORDER BY date DESC LIMIT ?',
    );

    query.setReadBigInts(true);

    return query.all(...values);
  }
}
