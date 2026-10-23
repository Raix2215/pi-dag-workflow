import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { connectFeature } from '../workflow/commands/connect.ts';
import type { createTodosOwner } from './domain/owner.ts';
import type { registerTodos } from './commands/register.ts';

export default async function (pi: ExtensionAPI): Promise<void> { await connectFeature(pi, 'todos'); }

export async function attachTodos(pi: ExtensionAPI, hooks: Omit<Parameters<typeof createTodosOwner>[0], 'changed'> & Pick<Parameters<typeof registerTodos>[1], 'show' | 'userPrompt' | 'retryStatus' | 'panel' | 'spawn'>) {
  const [{ createTodosOwner }, { registerCheckpoints }, { registerTodos }] = await Promise.all([import('./domain/owner.ts'), import('./commands/checkpoints.ts'), import('./commands/register.ts')]);
  let checkpoints: ReturnType<typeof registerCheckpoints>;
  const owner = createTodosOwner({ ...hooks, changed: ids => checkpoints.changed(ids) });
  checkpoints = registerCheckpoints(pi, { state: owner.state, jobs: hooks.jobs, protected: owner.protected, branch: hooks.branch });
  registerTodos(pi, { ...hooks, state: owner.state, mutate: owner.mutate, commit: owner.commit, reset: owner.reset, protected: owner.protected, presets: owner.presets, refreshPresets: owner.refreshPresets, previewClear: owner.previewClear });
  return { ...owner, checkpoints };
}
