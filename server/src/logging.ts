import type { ResolvedConfig } from '#src/config/index';

const levels = { NOTSET: 0, DEBUG: 10, INFO: 20, WARNING: 30, WARN: 30, ERROR: 40, CRITICAL: 50 };
let minimum = levels.INFO;

export function configureLogging(level: ResolvedConfig['logging']['level']) {
  minimum = levels[level];
}

export const log = {
  info: (...values: Parameters<typeof console.log>) => {
    if (minimum <= levels.INFO) console.log(...values);
  },
  warn: (...values: Parameters<typeof console.warn>) => {
    if (minimum <= levels.WARN) console.warn(...values);
  },
  error: (...values: Parameters<typeof console.error>) => {
    if (minimum <= levels.ERROR) console.error(...values);
  },
};
