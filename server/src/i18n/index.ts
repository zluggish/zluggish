import catalog from '@zluggish/i18n/en.json' with { type: 'json' };

const en = catalog;

export type MessageKey = keyof typeof en;
type InterpolationValue = string | number | boolean | bigint | null | undefined;

/** English for now; interpolate values as text, never as HTML. */
export function t<K extends MessageKey>(key: K, values?: Record<string, InterpolationValue>): string {
  return en[key].replaceAll(/\{(\w+)\}/g, (placeholder, name: string) =>
    values && Object.hasOwn(values, name) ? String(values[name]) : placeholder,
  );
}
