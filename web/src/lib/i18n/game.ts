import catalog from '@zluggish/i18n/en.json' with { type: 'json' };
import { createTranslator } from './translate';

const en = catalog;

export type MessageKey = keyof typeof en;
export const t = createTranslator(en);
