import { t } from '#src/i18n/index';
import { inputChanges } from '#src/dtos/meetup.dto';
import { overrideSchema } from '#src/dtos/settings.dto';
import { IsoDate, normalized, satisfies, Strict } from '#src/schema';
import { Schema } from 'effect';

export function normalizeLoginName(value: string) {
  return value.trim().toLowerCase();
}

export const loginName = normalized(
  normalizeLoginName,
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(254),
    satisfies<string>((value) => !/[\s\0]/.test(value), t('management_dto_login_name_invalid')),
  ),
);

export const password = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const credentialFields = { username: loginName, password };

export const credentials = Strict(credentialFields);

const newUserFields = {
  ...credentialFields,
  first_name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  last_name: Schema.Trim.check(Schema.isMaxLength(50)),
};

export const newUser = Strict(newUserFields);

export const setupRequest = Schema.Union([
  Strict({ ...newUserFields, mode: Schema.Literal('new'), key: Schema.String.check(Schema.isMaxLength(200)) }),
  Strict({
    ...credentialFields,
    mode: Schema.Literal('existing'),
    key: Schema.String.check(Schema.isMaxLength(200)),
  }),
  Strict({
    mode: Schema.Literal('existing'),
    key: Schema.String.check(Schema.isMaxLength(200)),
    player_id: Schema.Int.check(Schema.isGreaterThan(0)),
    password,
  }),
]);

export const mutationRequest = Strict({
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  operation: Schema.String.check(Schema.isUUID()),
  password: Schema.optional(password),
  role: Schema.optional(Schema.Literals(['rider', 'administrator'])),
});

export const editUserRequest = Strict({
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  operation: Schema.String.check(Schema.isUUID()),
  username: loginName,
  first_name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  last_name: Schema.Trim.check(Schema.isMaxLength(50)),
});

export const ownProfileRequest = Strict({
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  operation: Schema.String.check(Schema.isUUID()),
  username: loginName,
  first_name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  last_name: Schema.Trim.check(Schema.isMaxLength(50)),
  birthday: Schema.Union([Schema.Literal(''), IsoDate]),
});

export const settingsRequest = Strict({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  operation: Schema.String.check(Schema.isUUID()),
  overrides: overrideSchema,
});

export type JsonValue =
  | string
  | number
  | boolean
  | ReadonlyArray<JsonValue>
  | { [key: string]: JsonValue }
  | null
  | undefined;

export const eventRequest = Strict({
  operation: Schema.String.check(Schema.isUUID()),
  revision: Schema.String,
  changes: Schema.optional(inputChanges),
});

/** Chat commands that change bots for every user. Only the management area may send them. */
export const botCommand = Schema.Literals([
  'group',
  'groupall',
  'autogroup',
  'autogroupall',
  'stopautogroup',
  'disperse',
  'peloton',
]);

export const serverRequest = Strict({
  operation: Schema.String.check(Schema.isUUID()),
  user: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  command: Schema.optional(botCommand),
  argument: Schema.optional(Schema.Trim.check(Schema.isMaxLength(20))),
});

export const worldRequest = Strict({
  operation: Schema.String.check(Schema.isUUID()),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  id: Schema.String.check(Schema.isMaxLength(100)),
  values: Schema.Record(Schema.String, Schema.Json),
});
