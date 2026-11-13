import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export class IntegrationsRepository {
  constructor(private readonly db: DatabaseSync) {}
  deletePowerCurve(...values: SQLInputValue[]) {
    return this.db.prepare('DELETE FROM power_curve WHERE player_id=?').run(...values);
  }

  request(...args: Parameters<typeof fetch>) {
    return fetch(...args);
  }
}
