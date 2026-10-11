import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Offline regression only: isIdle can be true while later settled handlers still run. */
export default function slowSettled(pi: ExtensionAPI): void {
  let waited = false;
  pi.on('agent_settled', async (_event, ctx) => {
    if (waited) return;
    const last = ctx.sessionManager.getBranch().findLast((entry) => entry.type === 'message' && entry.message.role === 'assistant');
    if (last?.type !== 'message' || last.message.role !== 'assistant' || last.message.stopReason !== 'error') return;
    waited = true;
    pi.appendEntry('dag-test.slow-settled', { stage: 'waiting', idle: ctx.isIdle() });
    await new Promise((resolve) => setTimeout(resolve, 1800));
    pi.appendEntry('dag-test.slow-settled', { stage: 'finished' });
  });
}
