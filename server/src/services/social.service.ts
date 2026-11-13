import type { RepositoryContext } from '#src/context';
import type { SocialRepository } from '#src/repositories/social.repository';
import { BaseService } from '#src/services/base.service';
import { MessageService } from '#src/services/message.service';

export class SocialService extends BaseService {
  constructor(private readonly context: RepositoryContext) {
    super(context.accounts.repositories);
  }
  listUser(...values: Parameters<SocialRepository['listUser']>) {
    return this.socialRepository.listUser(...values);
  }
  findActivity(...values: Parameters<SocialRepository['findActivity']>) {
    return this.socialRepository.findActivity(...values);
  }
  insertPlayback(...values: Parameters<SocialRepository['insertPlayback']>) {
    return this.socialRepository.insertPlayback(...values);
  }

  playbackForSegment(...values: Parameters<SocialRepository['playbackForSegment']>) {
    return this.socialRepository.playbackForSegment(...values);
  }

  sendMessage(message: string, recipients?: bigint[], sender = 'Server') {
    return new MessageService(this.repositories).sendMessage(this.context, message, recipients, sender);
  }
}
