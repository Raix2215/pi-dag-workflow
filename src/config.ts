import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export const configPaths = () => {
  const directory = join(getAgentDir(), 'pi-dag-workflow');
  return { directory, config: join(directory, 'pi-dag-workflow-config.json'), profile: join(directory, 'pi-dag-workflow-profile.json') };
};
export interface WorkflowConfig { goalMaxTurns: number; goalNoProgressLimit: number }
export async function loadConfig(): Promise<WorkflowConfig> {
  const defaults = { goalMaxTurns: 20, goalNoProgressLimit: 3 };
  let source: string;
  try { source = await readFile(configPaths().config, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults; throw error; }
  if (Buffer.byteLength(source) > 16384) throw new Error('配置超过 16 KiB');
  const value = JSON.parse(source) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置需为 JSON 对象');
  for (const [key, item] of Object.entries(value)) {
    const max = key === 'goalMaxTurns' ? 200 : key === 'goalNoProgressLimit' ? 10 : 0;
    if (!max || typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1 || item > max) throw new Error(`未知或无效配置：${key}`);
  }
  return { ...defaults, ...value } as WorkflowConfig;
}
