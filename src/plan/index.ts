import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { connectFeature } from '../workflow/commands/connect.ts';
import type { createPlanOwner } from './domain/owner.ts';
import type { registerPlan } from './commands/register.ts';

export default async function (pi: ExtensionAPI): Promise<void> { await connectFeature(pi, 'plan'); }

export async function attachPlan(pi: ExtensionAPI, hooks: Parameters<typeof createPlanOwner>[0] & Omit<Parameters<typeof registerPlan>[1], 'commit' | 'protected'>) {
  const [{ createPlanOwner }, { registerPlan }] = await Promise.all([import('./domain/owner.ts'), import('./commands/register.ts')]);
  const owner = createPlanOwner(hooks);
  registerPlan(pi, { ...hooks, commit: owner.commit, protected: owner.protected });
  return owner;
}
