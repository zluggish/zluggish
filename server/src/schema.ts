import { t } from '#src/i18n/index';
import { Effect, Option, Predicate, Schema, SchemaGetter, SchemaIssue, SchemaTransformation } from 'effect';
import type { Types } from 'effect';

/** Decode options that reject undeclared keys at every level, for configuration files. */
export const strict = { onExcessProperty: 'error', errors: 'all' } as const;

const AnyObject = Schema.Record(Schema.String, Schema.Unknown);

export function Strict<const Fields extends Schema.Struct.Fields>(fields: Fields) {
  const keys = new Set(Object.keys(fields));

  return AnyObject.check(
    Schema.makeFilter((input: typeof AnyObject.Type) => {
      const extra = Object.keys(input).filter((key) => !keys.has(key));

      return extra.length === 0 || extra.map((key) => ({ path: [key], issue: t('schema_unknown_property') }));
    }),
  ).pipe(Schema.decodeTo(Schema.Struct(fields), SchemaTransformation.passthroughSupertype()));
}

/** A missing or undefined key decodes to `value`, which is then decoded by the schema. */
export function withDefault<S extends Schema.Constraint>(value: S['Encoded']) {
  return (schema: S) => Schema.withDecodingDefault<S>(Effect.succeed(value))(schema);
}

/** A missing or undefined key decodes to the value `make` returns at decode time. */
export function withLazyDefault<S extends Schema.Constraint>(make: () => S['Encoded']) {
  return (schema: S) => Schema.withDecodingDefault<S>(Effect.sync(make))(schema);
}

export function orElse<S extends Schema.Constraint>(value: S['Type']) {
  return (schema: S) => Schema.catchDecoding<S>(() => Effect.succeed(Option.some(value)))(schema);
}

export function satisfies<T>(predicate: (value: T) => boolean, message: string) {
  return Schema.makeFilter<T>((value) => predicate(value), { message, expected: message });
}

export const Text = Schema.String.check(satisfies((value: string) => !value.includes('\0'), t('invalid_string')));

export const NonBlank = Schema.String.check(
  satisfies((value: string) => value.trim().length > 0 && !value.includes('\0'), t('schema_string_required')),
);

export function IntBetween(minimum: number, maximum = Number.MAX_SAFE_INTEGER) {
  return Schema.Int.check(Schema.isBetween({ minimum, maximum }));
}

export const PositiveInt = IntBetween(1);

export const NonNegativeInt = IntBetween(0);

export const PositiveIntFromString = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));

export function FiniteAbove(minimum: number) {
  return Schema.Finite.check(Schema.isGreaterThan(minimum));
}

export function FiniteFrom(minimum: number) {
  return Schema.Finite.check(Schema.isGreaterThanOrEqualTo(minimum));
}

export interface SchemaProblem {
  /** Dotted path to the failing value; empty at the root. */
  readonly path: string;
  readonly message: string;
}

const standard = SchemaIssue.makeFormatterStandardSchemaV1();

/** Flatten a decoding failure into one problem per failing value. Inputs are never included. */
export function schemaProblems(error: Schema.SchemaError): Array<SchemaProblem> {
  return standard(error.issue).issues.map((issue) => ({
    path: (issue.path ?? []).map((key) => String(Predicate.isObject(key) && 'key' in key ? key.key : key)).join('.'),
    message: issue.message,
  }));
}

export function fieldErrors(error: Schema.SchemaError) {
  const fields: Record<string, Array<string>> = {};

  for (const problem of schemaProblems(error)) {
    (fields[problem.path.split('.', 1)[0] || 'form'] ??= []).push(problem.message);
  }

  return fields;
}

export const Url = Schema.String.check(satisfies((value: string) => URL.canParse(value), t('schema_url_invalid')));

export const Email = Schema.String.check(
  Schema.isPattern(/^(?!\.)(?!.*\.\.)([\w'+.-]*[\w+-])@([\da-z][\da-z-]*\.)+[a-z]{2,}$/i, {
    expected: t('schema_email_label'),
  }),
);

export const Lowercase = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((value: string) => value.toLowerCase()),
    encode: SchemaGetter.passthrough(),
  }),
);

export const NumberFromInput = Schema.Union([Schema.Finite, Schema.NumberFromString.check(Schema.isFinite())]);

/** An ISO 8601 UTC date-time such as `2024-01-01T08:00:00Z`, with optional fractional seconds. */
export const IsoDateTime = Schema.String.check(
  satisfies(
    (value: string) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/.test(value) && !Number.isNaN(Date.parse(value)),
    t('schema_utc_date_time_invalid'),
  ),
);

/** A calendar date such as `2024-02-29`. */
export const IsoDate = Schema.String.check(
  satisfies((value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }
    const date = new Date(`${value}T00:00:00Z`);

    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  }, t('schema_iso_date_invalid')),
);

export function normalized(normalize: (value: string) => string, schema: Schema.Codec<string, string>) {
  return Schema.String.pipe(
    Schema.decodeTo(schema, { decode: SchemaGetter.transform(normalize), encode: SchemaGetter.passthrough() }),
  );
}

/** Decode into a value the caller owns and may change. */
export function decodeOwned<S extends Schema.ConstraintDecoder<unknown>>(schema: S) {
  const decode = Schema.decodeUnknownSync(schema);

  // SAFETY: decoding builds new objects and arrays that nothing else references,
  // so the caller may change them.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (...input: Parameters<typeof decode>) => decode(...input) as Types.DeepMutable<S['Type']>;
}
