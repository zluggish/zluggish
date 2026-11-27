import { t } from '#src/i18n/index';
import { normalized, satisfies, Strict } from '#src/schema';
import { Schema } from 'effect';

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

/** A basic email shape, enough to tell an address from a placeholder or a typo. */
export function isEmail(value: string) {
  return value.length <= 254 && /^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/.test(value);
}

export const accessEmail = normalized(
  normalizeEmail,
  Schema.String.check(satisfies<string>(isEmail, t('access_email_invalid'))),
);

export const accessGroupName = normalized(
  (value) => value.trim(),
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(80),
    satisfies<string>((value) => !value.includes('\0'), t('invalid_string')),
  ),
);

export const accessGroupInput = Strict({ name: accessGroupName });
