import { t } from '#src/i18n/index';
import { Effect, Schema } from 'effect';

const emptyMessage = Schema.String.pipe(Schema.optionalKey, Schema.withConstructorDefault(Effect.succeed('')));

export class ApplicationError extends Schema.TaggedError<ApplicationError>()('ApplicationError', {
  status: Schema.Literals([400, 401, 403, 404, 409, 503]),
  message: emptyMessage,
}) {}

/** Stored provider credentials that the credentials key cannot decrypt: another key
wrote them, or they are damaged. The rider has to enter them again.
*/
export class UnreadableCredentialsError extends Schema.TaggedError<UnreadableCredentialsError>()(
  'UnreadableCredentialsError',
  { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/** The provider did not complete the delivery: the request was not sent, or the
provider rejected it. Any other delivery error has an unknown remote result.
*/
export class DeliveryRefusedError extends Schema.TaggedError<DeliveryRefusedError>()('DeliveryRefusedError', {
  code: Schema.String,
}) {
  override get message() {
    return this.code;
  }
}

/** 4xx responses reject the request; 408, 425 and 429 may follow a completed request. */
export function refused(status: number) {
  return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
}

/** A failure with a safe code. Other errors record only their type name. */
export class JobError extends Schema.TaggedError<JobError>()('JobError', {
  code: Schema.String,
  retry: Schema.Boolean.pipe(Schema.optionalKey, Schema.withConstructorDefault(Effect.succeed(true))),
}) {
  override get message() {
    return this.code;
  }
}

export class FitQueueFullError extends Schema.TaggedError<FitQueueFullError>()('FitQueueFullError', {}) {
  override get message() {
    return t('errors_fit_queue_full');
  }
}
