import { t } from './i18n/shared';
import type { GameField, GameForm } from '../lib/game-app.dto';

export function values(form: GameForm) {
  return Object.fromEntries(
    form.fields.map((field) => [field.name, field.value ?? (field.type === 'checkbox' ? false : '')]),
  );
}

export function visible(field: GameField, draft: Record<string, string | boolean>) {
  return !field.when || draft[field.when.field] === field.when.value;
}

export function validation(form: GameForm, draft: Record<string, string | boolean>) {
  const errors: Record<string, Array<string>> = {};

  for (const field of form.fields) {
    if (!visible(field, draft) || field.type === 'hidden') {
      continue;
    }
    const value = draft[field.name];

    if (field.required && !value) {
      errors[field.name] = [t('validation_required')];
    } else if (field.maxLength && String(value).length > field.maxLength) {
      errors[field.name] = [t('validation_max_length', { value1: field.maxLength })];
    } else if (field.pattern && value && !new RegExp(field.pattern).test(String(value))) {
      errors[field.name] = [t('validation_invalid_value')];
    } else if (field.matches && value !== draft[field.matches]) {
      errors[field.name] = [t('validation_password_mismatch')];
    }
  }

  return errors;
}

export function safeNavigation(path: string) {
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') && !/%(?:2f|5c)/i.test(path);
}
