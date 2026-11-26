import { t } from './i18n/shared';
import { z } from 'zod';
import type { JsonObject } from './connection';

export type ApiValue = string | number | boolean | null | undefined | Array<ApiValue> | { [key: string]: ApiValue };

export type ApiPayload = { [key: string]: ApiValue };

export type Api = <Schema extends z.ZodType>(
  schema: Schema,
  url: string,
  method?: string,
  data?: ApiPayload | FormData | Blob,
) => Promise<z.output<Schema>>;

export const ignored = z.unknown();

const optionalString = z.string().optional();

const optionalFieldErrors = z.record(z.string(), z.array(z.string())).optional();

/** Fields any response may carry. A field of another shape reads as missing rather than failing the response. */
export function responseFields(body: JsonObject) {
  const csrf = optionalString.safeParse(body.csrf);
  const message = optionalString.safeParse(body.message);
  const fieldErrors = optionalFieldErrors.safeParse(body.fieldErrors);

  return {
    csrf: csrf.success ? csrf.data : undefined,
    message: message.success ? message.data : undefined,
    fieldErrors: fieldErrors.success ? fieldErrors.data : undefined,
  };
}

export class UnexpectedResponseError extends Error {
  constructor() {
    super(t('api_unexpected_response'));
  }
}

export function decode<Schema extends z.ZodType>(schema: Schema, body: unknown): z.output<Schema> {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new UnexpectedResponseError();
  }

  return parsed.data;
}
