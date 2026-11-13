import * as files from '#src/repositories/files.repository';

/** Access to opaque local assets; repositories own filesystem semantics. */
export class FilesService {
  readonly exists = files.existsSync;
  readonly read = files.readFileSync;
  readonly list = files.readdirSync;
  readonly remove = files.rmSync;
  readonly unlink = files.unlinkSync;
  readonly stat = files.statSync;
  readonly write = files.writeDurable;
}
