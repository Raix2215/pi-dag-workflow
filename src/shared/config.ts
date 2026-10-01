import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { chinese, resolveLocale, type Language, type Locale, type Translator } from './i18n.ts';

export const configPaths = () => {
  const directory = join(getAgentDir(), 'pi-dag-workflow');
  return { directory, config: join(directory, 'pi-dag-workflow-config.json'), profile: join(directory, 'pi-dag-workflow-profile.json') };
};
export interface WorkflowConfig { language: Language; goalMaxTurns: number; goalNoProgressLimit: number }
const defaults: WorkflowConfig = { language: 'auto', goalMaxTurns: 20, goalNoProgressLimit: 3 };
function parseConfig(source: string, msg: Translator): WorkflowConfig {
  if (Buffer.byteLength(source) > 16384) throw new Error(msg('配置超过 16 KiB'));
  const value = JSON.parse(source) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(msg('配置需为 JSON 对象'));
  for (const [key, item] of Object.entries(value)) {
    if (key === 'language') {
      if (!['auto', 'en', 'zh-CN'].includes(item as string)) throw new Error(msg('language 需为 auto、en 或 zh-CN'));
      continue;
    }
    if (key === 'modules') throw new Error(msg('modules 配置已移除；请从此文件删除该字段，并用 pi config 勾选扩展入口'));
    const max = key === 'goalMaxTurns' ? 200 : key === 'goalNoProgressLimit' ? 10 : 0;
    if (!max || typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1 || item > max) throw new Error(msg`未知或无效配置：${key}`);
  }
  return { ...defaults, ...value } as WorkflowConfig;
}
export async function loadConfig(msg: Translator = chinese): Promise<WorkflowConfig> {
  let source: string;
  try { source = await readFile(configPaths().config, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaults }; throw error; }
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
