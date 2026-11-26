type InterpolationValue = string | number | boolean | bigint | null | undefined;

/** Interpolate as plain text. Each entry point supplies only its own English catalog. */
export function createTranslator<Catalog extends Record<string, string>>(catalog: Catalog) {
  return function t<K extends keyof Catalog>(key: K, values?: Record<string, InterpolationValue>): string {
    return catalog[key].replaceAll(/\{(\w+)\}/g, (placeholder, name: string) =>
      values && Object.hasOwn(values, name) ? String(values[name]) : placeholder,
    );
  };
}
