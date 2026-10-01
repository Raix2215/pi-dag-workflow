import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadModules } from './shared/config.ts';
import { registerWorkflow } from './workflow/index.ts';

/** Public Pi entry: one coordinator, only selected tools and lifecycle modules. */
export default async function piDagWorkflow(pi: ExtensionAPI): Promise<void> {
  const modules = await loadModules();
  if (modules.todos || modules.plan || modules.agents || modules.goal) registerWorkflow(pi, modules);
}
