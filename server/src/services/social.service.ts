import type { RepositoryContext } from '#src/context';
import { sendMessage } from '#src/services/message.service';
import type { SocialRepository } from '#src/repositories/social.repository';

export class SocialService {
  constructor(
    private readonly repository: SocialRepository,
    private readonly context: RepositoryContext,
  ) {}
  listUser(...values: Parameters<SocialRepository['listUser']>) {
    return this.repository.listUser(...values);
  }
  findActivity(...values: Parameters<SocialRepository['findActivity']>) {
    return this.repository.findActivity(...values);
  }
  insertPlayback(...values: Parameters<SocialRepository['insertPlayback']>) {
    return this.repository.insertPlayback(...values);
  }

  playbackForSegment(...values: Parameters<SocialRepository['playbackForSegment']>) {
    return this.repository.playbackForSegment(...values);
  }

  sendMessage(message: string, recipients?: bigint[], sender = 'Server') {
    return sendMessage(this.context, message, recipients, sender);
  }
}
