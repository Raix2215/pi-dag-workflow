import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { chinese, resolveLocale, type Language, type Locale, type Translator } from './i18n.ts';

export const configPaths = () => {
  const directory = join(getAgentDir(), 'pi-dag-workflow');
  return { directory, config: join(directory, 'pi-dag-workflow-config.json'), profile: join(directory, 'pi-dag-workflow-profile.json'), preset: join(directory, 'pi-dag-workflow-preset.json') };
};
export interface WorkflowConfig { language: Language; goalMaxTurns: number; goalNoProgressLimit: number; goalErrorRetries: number; planTools: string[]; goalNoPauseTools: string[] }
export const defaultConfig = (): WorkflowConfig => ({ language: 'auto', goalMaxTurns: 32, goalNoProgressLimit: 8, goalErrorRetries: 5, planTools: [], goalNoPauseTools: ['ask_user_question'] });
/** Machine-wide extra read-only tools for Plan mode; hard guards (write/shell/dispatch) still win. */
export const MAX_PLAN_TOOLS = 16;
/** Accepted range per key; an absent key is a default, an out-of-range value is an error. */
const limits: Record<string, { min: number; max: number }> = { goalMaxTurns: { min: 1, max: 200 }, goalNoProgressLimit: { min: 1, max: 100 }, goalErrorRetries: { min: 0, max: 20 } };
function parseConfig(source: string, msg: Translator): WorkflowConfig {
  if (Buffer.byteLength(source) > 16384) throw new Error(msg('配置超过 16 KiB'));
  const value = JSON.parse(source) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(msg('配置需为 JSON 对象'));
  for (const [key, item] of Object.entries(value)) {
    if (key === 'language') {
      if (!['auto', 'en', 'zh-CN'].includes(item as string)) throw new Error(msg('language 需为 auto、en 或 zh-CN'));
      continue;
    }
    if (key === 'modules') throw new Error(msg('modules 不是配置项；模块选择用 pi config 勾选扩展入口'));
    if (key === 'planTools' || key === 'goalNoPauseTools') {
      const names = Array.isArray(item) ? (item as unknown[]).map((entry) => typeof entry === 'string' ? entry.trim() : '') : [];
      const valid = Array.isArray(item) && names.length <= MAX_PLAN_TOOLS && names.every((name) => /^[\w-]+$/.test(name)) && new Set(names).size === names.length;
      if (!valid) throw new Error(msg`${key} 需为最多 ${MAX_PLAN_TOOLS} 个不重复的工具名`);
      value[key] = names;
      continue;
    }
    const range = limits[key];
    if (!range || typeof item !== 'number' || !Number.isSafeInteger(item) || item < range.min || item > range.max) throw new Error(msg`未知或无效配置：${key}`);
  }
  return { ...defaultConfig(), ...value } as WorkflowConfig;
}
export async function loadConfig(msg: Translator = chinese): Promise<WorkflowConfig> {
  let source: string;
  try { source = await readFile(configPaths().config, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig(); throw error; }
  return parseConfig(source, msg);
}

/** Read once when a runtime is assembled so command metadata and UI use the same language.
 * Goal's restore reports invalid configuration; localization itself never prevents recovery. */
export function loadLocale(): Locale {
  try {
    const source = readFileSync(configPaths().config, 'utf8');
    if (Buffer.byteLength(source) <= 16384) {
      const value = JSON.parse(source) as Record<string, unknown> | null;
      if (value && ['auto', 'en', 'zh-CN'].includes(value.language as string)) return resolveLocale(value.language as Language);
    }
  } catch { /* Missing or invalid settings use terminal preferences until repaired. */ }
  return resolveLocale();
}
