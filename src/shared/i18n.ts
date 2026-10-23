import { englishMessages } from './messages.en.ts';

export type Locale = 'en' | 'zh-CN';
export type Language = Locale | 'auto';
export interface Translator {
  readonly locale?: Locale;
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
  return Object.assign((parts: string | TemplateStringsArray, ...values: unknown[]) => {
    const key = typeof parts === 'string' ? parts : parts.reduce((text, part, index) => text + (index ? `{${index - 1}}` : '') + part, '');
    const template = locale === 'en' && Object.hasOwn(englishMessages, key) ? englishMessages[key]! : key;
    return template.replace(/\{(\d+)\}/g, (marker, index: string) => Number(index) < values.length ? String(values[Number(index)]) : marker);
  }, { locale });
}

const savedMessageKeys = new Map(Object.entries(englishMessages)
  .filter(([key]) => !/\{\d+\}/.test(key))
  .map(([key, value]) => [value, key]));

/** Only for plugin-owned saved labels/reasons, never user-authored fields. */
export function localizeSavedMessage(value: string, msg: Translator): string {
  return msg(savedMessageKeys.get(value) ?? value);
}

let savedEnglishTemplates: { pattern: RegExp; slots: number[]; english: string }[] | undefined;
/** Model view of plugin-owned saved reasons only. Never apply this to user text or external diagnostics. */
export function englishSavedMessage(value: string): string {
  const direct = Object.hasOwn(englishMessages, value) ? englishMessages[value] : undefined;
  if (direct !== undefined) return direct;
  if (value.length > 4096) return value; // Long external diagnostics are data, not generated labels.
  savedEnglishTemplates ??= Object.entries(englishMessages).filter(([key]) => /\{\d+\}/.test(key)).map(([key, english]) => {
    const slots: number[] = [];
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let pattern = '^', from = 0;
    for (const marker of key.matchAll(/\{(\d+)\}/g)) {
      pattern += escape(key.slice(from, marker.index)) + '(.*?)'; slots.push(Number(marker[1])); from = marker.index! + marker[0].length;
    }
    return { pattern: new RegExp(pattern + escape(key.slice(from)) + '$', 's'), slots, english };
  });
  for (const item of savedEnglishTemplates) {
    const match = item.pattern.exec(value);
    if (match) {
      const values = new Map(item.slots.map((slot, at) => [slot, match[at + 1]!]));
      return item.english.replace(/\{(\d+)\}/g, (marker, index: string) => values.get(Number(index)) ?? marker);
    }
  }
  return value.includes('\n') ? value.split('\n').map(englishSavedMessage).join('\n') : value;
}

/** Default for pure helpers that receive no translator; the runtime supplies its resolved locale. */
export const chinese = createTranslator('zh-CN');
