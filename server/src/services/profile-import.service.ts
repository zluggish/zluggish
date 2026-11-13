import type { ProfileImports } from '#src/repositories/profile-import.repository';

export class ImportsService {
  constructor(private readonly repository: ProfileImports) {}
  folder(...args: Parameters<ProfileImports['folder']>) {
    return this.repository.folder(...args);
  }
  prepare(...args: Parameters<ProfileImports['prepare']>) {
    return this.repository.prepare(...args);
  }
  inspect(...args: Parameters<ProfileImports['inspect']>) {
    return this.repository.inspect(...args);
  }
  publish(...args: Parameters<ProfileImports['publish']>) {
    return this.repository.publish(...args);
  }
  cancel(...args: Parameters<ProfileImports['cancel']>) {
    return this.repository.cancel(...args);
  }
  rollback(...args: Parameters<ProfileImports['rollback']>) {
    return this.repository.rollback(...args);
  }
  recover(...args: Parameters<ProfileImports['recover']>) {
    return this.repository.recover(...args);
  }
}
