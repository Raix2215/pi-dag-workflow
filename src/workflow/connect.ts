import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Feature } from './features.ts';
import { createWorkflow } from './index.ts';

const CHANNEL = 'pi-dag-workflow:coordinator:v1';
interface Request { workflow?: ReturnType<typeof createWorkflow> }

/** Pi's runtime-owned bus subscriptions are removed on invalidation/reload.
 * No global singleton, required core entry, or dependency on factory load order. */
export async function connectFeature(pi: ExtensionAPI, feature: Feature): Promise<void> {
  const request: Request = {};
  pi.events.emit(CHANNEL, request);
  if (!request.workflow) {
    const workflow = createWorkflow(pi);
    const off = pi.events.on(CHANNEL, (data) => { (data as Request).workflow ??= workflow; });
    workflow.onDispose(off);
    request.workflow = workflow;
  }
  await request.workflow.attach(feature, pi);
}
