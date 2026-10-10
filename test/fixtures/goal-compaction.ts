import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Deterministic memory/compaction extension for actual Pi event-flow tests. No model calls. */
export default function goalCompaction(pi: ExtensionAPI): void {
  let rejectOnce = false;
  let compactAfterSettle = false;
  let slowCompletion = false;
  let hideContracts = false;
  pi.registerCommand('test-hide-goal-contract', { description: 'Offline test: ordinary memory hides Goal contracts', handler: async () => { hideContracts = true; } });
  pi.registerCommand('test-compact-slow-race', { description: 'Compact with slow completion handlers after discarding a wake', handler: async () => { rejectOnce = true; slowCompletion = true; } });
  pi.on('session_compact', async () => {
    if (!slowCompletion) return;
    slowCompletion = false;
    await new Promise((resolve) => setTimeout(resolve, 180));
  });
  pi.registerCommand('test-compact-race', { description: 'Discard one proposed continuation and compact before idle recovery', handler: async () => { rejectOnce = true; } });
  pi.on('agent_before_settle', (event) => {
    if (!rejectOnce || !event.entries.some((entry) => entry.type === 'custom_message' && entry.customType === 'pi-dag-workflow.goal-continue')) return;
    rejectOnce = false; compactAfterSettle = true;
    return { entries: event.entries.filter((entry) => entry.type !== 'custom_message' || entry.customType !== 'pi-dag-workflow.goal-continue'), continue: false };
  });
  pi.on('agent_settled', (_event, ctx) => {
    if (!compactAfterSettle) return;
    compactAfterSettle = false;
    ctx.compact({ onError: (error) => { throw error; } });
  });
  pi.on('session_before_compact', (event) => {
    const lastUser = event.branchEntries.findLast((entry) => entry.type === 'message' && entry.message.role === 'user');
    return { compaction: { summary: 'FIXTURE COMPACTION: preserve the active workflow and its next action.', firstKeptEntryId: lastUser?.id ?? event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
  });
  pi.on('context', (event, ctx) => {
    // Stand in for a memory owner: project only its own summary. A real transform may filter
    // any other messages; the workflow must neither replace this projection nor replay reports.
    const messages = event.messages.filter((message) => !hideContracts || (message as { customType?: string }).customType !== 'pi-dag-workflow.goal-checkpoint').map((message) => message.role === 'compactionSummary' ? { ...message, summary: `MEMORY PROJECTION: ${message.summary}` } : message);
    appendFileSync(join(ctx.cwd, 'goal-compaction-context.jsonl'), JSON.stringify(messages) + '\n');
    return { messages };
  });
}
