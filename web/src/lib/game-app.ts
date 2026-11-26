import { z } from 'zod';
import type { FormResult, GameField, GameForm, GamePageModel, GameSaved } from './game-app.dto';

// The annotations make the compiler check each schema against the shared contract in game-app.dto.d.ts.

const gameField: z.ZodType<GameField> = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(['text', 'password', 'checkbox', 'hidden', 'select']).optional(),
  value: z.union([z.string(), z.boolean()]).optional(),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
  maxLength: z.number().optional(),
  pattern: z.string().optional(),
  autocomplete: z.enum(['username', 'new-password', 'current-password', 'one-time-code']).optional(),
  matches: z.string().optional(),
  autofocus: z.boolean().optional(),
  when: z.object({ field: z.string(), value: z.union([z.string(), z.boolean()]) }).optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
});

const gameForm: z.ZodType<GameForm> = z.object({
  id: z.string(),
  action: z.string(),
  title: z.string().optional(),
  fields: z.array(gameField),
  buttons: z.array(
    z.object({
      label: z.string(),
      name: z.string().optional(),
      value: z.string().optional(),
      skipValidation: z.boolean().optional(),
    }),
  ),
  navigation: z.boolean().optional(),
  confirmation: z.string().optional(),
  primary: z.boolean().optional(),
  transient: z.boolean().optional(),
  user: z
    .object({
      initials: z.string(),
      photo: z.string().nullable(),
      email: z.string().nullable(),
      workout: z.object({ name: z.string(), minutes: z.number() }).nullable().optional(),
    })
    .optional(),
});

/** A launcher page, as the server renders it and as a saved form returns it. */
export const gamePageModel: z.ZodType<GamePageModel> = z.object({
  kind: z.enum(['login', 'unlock', 'dashboard', 'message']),
  title: z.string(),
  csrf: z.string(),
  version: z.string(),
  zwiftVersion: z.string().optional(),
  webApp: z.string().nullable().optional(),
  forms: z.array(gameForm),
  back: z.object({ href: z.string(), label: z.string() }).optional(),
  message: z.string().optional(),
  failed: z.boolean().optional(),
  warning: z.string().optional(),
  errorStatus: z.union([z.literal(400), z.literal(403), z.literal(409)]).optional(),
});

export const savedFormResult: z.ZodType<FormResult<GameSaved>> = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    data: z.object({ page: gamePageModel.optional() }),
    message: z.string().optional(),
    redirectTo: z.string().optional(),
  }),
  z.object({
    ok: z.literal(false),
    message: z.string(),
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
    reload: z.boolean().optional(),
  }),
]);
