import { t } from '#src/i18n/index';
import { packageVersion, supportedZwiftVersion } from '#src/config/load';
import type { GameField, GameForm, GamePageModel } from '#src/dtos/game-app.dto';
import type { RuntimeEnv } from '#src/http/runtime';
import type { Context } from 'hono';

export function field(name: string, label: string, options: Omit<GameField, 'name' | 'label'> = {}): GameField {
  return { name, label, ...options };
}

export function hidden(name: string, value: string): GameField {
  return field(name, '', { type: 'hidden', value });
}

export function checkbox(name: string, label: string, value = false): GameField {
  return field(name, label, { type: 'checkbox', value });
}

export function form(
  id: string,
  action: string,
  fields: Array<GameField>,
  label: string,
  options: Partial<GameForm> = {},
): GameForm {
  return {
    id,
    action,
    fields: [
      ...fields,
      ...(options.confirmation
        ? [
            field('confirm_action', t('i_confirm', { value1: options.confirmation }), {
              type: 'checkbox',
              required: true,
            }),
          ]
        : []),
    ],
    buttons: [{ label }],
    ...options,
  };
}

export function model(
  c: Context<RuntimeEnv>,
  kind: GamePageModel['kind'],
  title: string,
  forms: Array<GameForm>,
  extra: Partial<GamePageModel> = {},
): GamePageModel {
  return {
    kind,
    title,
    csrf: c.get('browser').csrf,
    version: packageVersion(),
    zwiftVersion: supportedZwiftVersion(),
    forms,
    ...extra,
  };
}
