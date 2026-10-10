import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Public-API-only observation of the gap after the low-level run, with no host mutation. */
export default function lateSettle(pi: ExtensionAPI) {
  pi.registerFlag('dag-test-late-settle', { type: 'boolean', description: 'Offline cancellation test: await provider-aborted before-settle' });
  let lastRunSignal: AbortSignal | undefined;
  pi.on('agent_end', (_event, ctx) => { lastRunSignal = ctx.signal; });
  pi.on('agent_before_settle', async (event, ctx) => {
    if (pi.getFlag('dag-test-late-settle') !== true || event.outcome !== 'aborted') return;
    const observe = (stage: string) => pi.appendEntry('dag-test.late-settle', {
      stage, outcome: event.outcome, idle: ctx.isIdle(),
      publicSignalAborted: ctx.signal?.aborted ?? null,
      capturedSignalAborted: lastRunSignal?.aborted ?? null,
    });
    observe('waiting');
    await new Promise((resolve) => setTimeout(resolve, 450));
    observe('finished');
  });
}
