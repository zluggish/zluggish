import type { Connections } from '#src/repositories/connections.repository';

export class ConnectionsService {
  constructor(private readonly repository: Connections) {}
  file(...args: Parameters<Connections['file']>) {
    return this.repository.file(...args);
  }
  read(...args: Parameters<Connections['read']>) {
    return this.repository.read(...args);
  }
  save(...args: Parameters<Connections['save']>) {
    return this.repository.save(...args);
  }
  remove(...args: Parameters<Connections['remove']>) {
    return this.repository.remove(...args);
  }
}
