import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export const MODULE_NAMES = ['todos', 'plan', 'agents', 'goal', 'ui'] as const;
export type ModuleName = typeof MODULE_NAMES[number];
export type Modules = Record<ModuleName, boolean>;
export const configPaths = () => {
  const directory = join(getAgentDir(), 'pi-dag-workflow');
  return { directory, config: join(directory, 'pi-dag-workflow-config.json'), profile: join(directory, 'pi-dag-workflow-profile.json') };
};
export interface WorkflowConfig { goalMaxTurns: number; goalNoProgressLimit: number; modules?: ModuleName[] }
async function readObject(): Promise<Record<string, unknown>> {
  let source: string;
  try { source = await readFile(configPaths().config, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  if (Buffer.byteLength(source) > 16384) throw new Error('配置超过 16 KiB');
  const value = JSON.parse(source) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置需为 JSON 对象');
  return value;
}
function names(value: unknown): ModuleName[] {
  if (value === undefined) return [...MODULE_NAMES];
  if (!Array.isArray(value) || value.some((name) => !MODULE_NAMES.includes(name))) throw new Error(`modules 只接受：${MODULE_NAMES.join(', ')}`);
  return [...new Set(value)] as ModuleName[];
}
/** Selection is resolved before tool registration; one entry owns shared execution safety. */
export async function loadModules(): Promise<Modules> {
  const selected = new Set(names((await readObject()).modules));
  return Object.fromEntries(MODULE_NAMES.map((name) => [name, selected.has(name)])) as Modules;
}
export async function loadConfig(): Promise<WorkflowConfig> {
  const defaults = { goalMaxTurns: 20, goalNoProgressLimit: 3 };
  const value = await readObject();
  for (const [key, item] of Object.entries(value)) {
    if (key === 'modules') { names(item); continue; }
    const max = key === 'goalMaxTurns' ? 200 : key === 'goalNoProgressLimit' ? 10 : 0;
    if (!max || typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1 || item > max) throw new Error(`未知或无效配置：${key}`);
  }
  return { ...defaults, ...value } as WorkflowConfig;
}
