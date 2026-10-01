import { englishMessages } from './messages.en.ts';

export type Locale = 'en' | 'zh-CN';
export type Language = Locale | 'auto';
export interface Translator {
  (message: string): string;
  (parts: TemplateStringsArray, ...values: unknown[]): string;
}

/** Terminal preferences only; never infer a language from user-authored content. */
export function resolveLocale(language: Language = 'auto', env: NodeJS.ProcessEnv = process.env): Locale {
  if (language !== 'auto') return language;
  const value = env.LC_ALL || env.LC_MESSAGES || env.LANGUAGE?.split(':')[0] || env.LANG || '';
  return /^zh(?:[-_]|$)/i.test(value) ? 'zh-CN' : 'en';
}

/** Translate static templates before interpolation, leaving user data untouched. */
export function createTranslator(locale: Locale): Translator {
  return (parts: string | TemplateStringsArray, ...values: unknown[]) => {
    const key = typeof parts === 'string' ? parts : parts.reduce((text, part, index) => text + (index ? `{${index - 1}}` : '') + part, '');
    const template = locale === 'en' && Object.hasOwn(englishMessages, key) ? englishMessages[key]! : key;
    return template.replace(/\{(\d+)\}/g, (marker, index: string) => Number(index) < values.length ? String(values[Number(index)]) : marker);
  };
}

const savedMessageKeys = new Map(Object.entries(englishMessages)
  .filter(([key]) => !/\{\d+\}/.test(key))
  .map(([key, value]) => [value, key]));

/** Only for plugin-owned saved labels/reasons, never user-authored fields. */
export function localizeSavedMessage(value: string, msg: Translator): string {
  return msg(savedMessageKeys.get(value) ?? value);
}

/** Compatibility default for pure helpers; the runtime supplies its resolved locale. */
export const chinese = createTranslator('zh-CN');
