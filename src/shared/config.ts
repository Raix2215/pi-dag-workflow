import { readConfigTextSync, configPaths, readWorkflowConfig, writeWorkflowConfig, resolveExtensionPaths } from './config-file.ts';
import { chinese, resolveLocale, type Language, type Locale, type Translator } from './i18n.ts';
export { configPaths, childExtensionPath } from './config-file.ts';

export type IconStyleName = 'nerd-font' | 'plain';
export type DesktopTerminalName = 'auto' | 'none' | 'kitty' | 'gnome-terminal' | 'konsole' | 'alacritty' | 'xfce4-terminal' | 'wezterm' | 'wt';
export interface WorkflowConfig { language: Language; goalMaxTurns: number; goalNoProgressLimit: number; goalErrorRetries: number; planTools: string[]; goalNoPauseTools: string[]; iconStyle: IconStyleName; modelLabelWidth: number; desktopTerminal: DesktopTerminalName; desktopCommand: string }
/** Every accepted `desktopTerminal` value, in panel cycle order. */
export const DESKTOP_TERMINALS: readonly DesktopTerminalName[] = ['auto', 'kitty', 'gnome-terminal', 'konsole', 'alacritty', 'xfce4-terminal', 'wezterm', 'wt', 'none'];
/** A template must say where the command goes, and stay short enough to read in a row. */
export const DESKTOP_COMMAND_LIMIT = 200;
export const validDesktopCommand = (template: string): boolean => template.trim().length <= DESKTOP_COMMAND_LIMIT && template.includes('{command}');
export const defaultConfig = (): WorkflowConfig => ({ language: 'auto', goalMaxTurns: 32, goalNoProgressLimit: 8, goalErrorRetries: 5, planTools: [], goalNoPauseTools: ['ask_user_question'], iconStyle: 'nerd-font', modelLabelWidth: 18, desktopTerminal: 'auto', desktopCommand: '' });
/** Machine-wide extra read-only tools for Plan mode; hard guards (write/shell/dispatch) still win. */
const MAX_PLAN_TOOLS = 16;
/** Accepted range per key; an absent key is a default, an out-of-range value is an error. */
const limits: Record<string, { min: number; max: number }> = { goalMaxTurns: { min: 1, max: 200 }, goalNoProgressLimit: { min: 1, max: 100 }, goalErrorRetries: { min: 0, max: 20 } };
function parseConfig(source: string, msg: Translator, domain?: 'goal' | 'plan' | 'agents' | 'team'): WorkflowConfig {
  if (Buffer.byteLength(source) > 16384) throw new Error(msg('配置超过 16 KiB'));
  const value = JSON.parse(source) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(msg('配置需为 JSON 对象'));
  for (const [key, item] of Object.entries(value)) {
    if (domain === 'agents' && !['language', 'iconStyle', 'modelLabelWidth'].includes(key)) { delete value[key]; continue; }
    if (domain === 'plan' && !['language', 'planTools'].includes(key) || domain === 'goal' && !['language', 'goalMaxTurns', 'goalNoProgressLimit', 'goalErrorRetries', 'goalNoPauseTools'].includes(key) || domain === 'team' && !['language', 'desktopTerminal', 'desktopCommand'].includes(key)) { delete value[key]; continue; }
    if (key === 'desktopTerminal') {
      if (!DESKTOP_TERMINALS.includes(item as DesktopTerminalName)) throw new Error(msg`desktopTerminal 需为 ${DESKTOP_TERMINALS.join('、')} 之一`);
      continue;
    }
    if (key === 'desktopCommand') {
      if (typeof item !== 'string' || (item.trim() !== '' && !validDesktopCommand(item))) throw new Error(msg('desktopCommand 模板必须包含 {command}，且不超过 200 字符'));
      continue;
    }
    if (key === 'iconStyle') {
      if (!['nerd-font', 'plain'].includes(item as string)) throw new Error(msg('iconStyle 需为 nerd-font 或 plain'));
      continue;
    }
    if (key === 'modelLabelWidth') {
      if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 6 || item > 18) throw new Error(msg('modelLabelWidth 需为 6–18 的整数'));
      continue;
    }
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
export async function loadConfig(msg: Translator = chinese, domain?: 'goal' | 'plan' | 'agents' | 'team'): Promise<WorkflowConfig> {
  const source = await readWorkflowConfig(msg('配置超过 16 KiB'));
  return source === undefined ? defaultConfig() : parseConfig(source, msg, domain);
}

/** Comma-separated tool names for the panel editors; `undefined` means the input is invalid. */
export function parseToolList(value: string): string[] | undefined {
  const text = value.trim();
  if (!text) return [];
  const names = text.split(',').map(name => name.trim());
  if (names.some(name => !/^[\w-]+$/.test(name))) return undefined;
  const unique = [...new Set(names)];
  return unique.length <= 16 ? unique : undefined;
}

export async function writeConfig(patch: Partial<WorkflowConfig>, msg: Translator = chinese): Promise<void> {
  // Validate before touching the file: a rejected template must leave the stored config unchanged.
  if (patch.desktopTerminal !== undefined && !DESKTOP_TERMINALS.includes(patch.desktopTerminal)) throw new Error(msg`desktopTerminal 需为 ${DESKTOP_TERMINALS.join('、')} 之一`);
  if (patch.desktopCommand !== undefined && patch.desktopCommand.trim() !== '' && !validDesktopCommand(patch.desktopCommand)) throw new Error(msg('desktopCommand 模板必须包含 {command}，且不超过 200 字符'));
  await writeWorkflowConfig(patch, msg, (cause, config) => new Error(msg`无法写入配置 ${config}：${String(cause)}`));
}

export async function resolveChildExtensionPaths(paths: string[] | undefined, msg: Translator = chinese): Promise<string[]> {
  return resolveExtensionPaths(paths, entry => msg`子扩展文件不存在或不可读：${entry}；编辑 pi-dag-workflow-profile.json 里对应 Profile 的 childExtensions，或运行 /agents 展开该 Profile 修改`);
}

/** Display settings are read synchronously at assembly so panels/widgets style correctly before any async work. */
export function loadDisplaySettings(): { iconStyle: IconStyleName; modelLabelWidth: number; language: Language } {
  const base = defaultConfig();
  const fallback = { iconStyle: base.iconStyle, modelLabelWidth: base.modelLabelWidth, language: base.language };
  try {
    const source = readConfigTextSync(configPaths().config, 16384, 'Config exceeds 16 KiB');
    if (source === undefined) return fallback;
    // Lenient read: unknown user keys must not block display settings or a later write.
    const value = JSON.parse(source) as Record<string, unknown> | null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
    const iconStyle: IconStyleName = value.iconStyle === 'plain' ? 'plain' : 'nerd-font';
    const width = typeof value.modelLabelWidth === 'number' && Number.isSafeInteger(value.modelLabelWidth) && value.modelLabelWidth >= 6 && value.modelLabelWidth <= 18 ? value.modelLabelWidth : base.modelLabelWidth;
    const language: Language = ['auto', 'en', 'zh-CN'].includes(value.language as string) ? value.language as Language : base.language;
    return { iconStyle, modelLabelWidth: width, language };
  } catch { return fallback; }
}

/** Read once when a runtime is assembled so command metadata and UI use the same language.
 * Goal's restore reports invalid configuration; localization itself never prevents recovery. */
export function loadLocale(): Locale {
  try {
    const source = readConfigTextSync(configPaths().config, 16384, 'Config exceeds 16 KiB');
    if (Buffer.byteLength(source) <= 16384) {
      const value = JSON.parse(source) as Record<string, unknown> | null;
      if (value && ['auto', 'en', 'zh-CN'].includes(value.language as string)) return resolveLocale(value.language as Language);
    }
  } catch { /* Missing or invalid settings use terminal preferences until repaired. */ }
  return resolveLocale();
}
