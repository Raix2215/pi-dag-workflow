import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Test-only public command APIs, never shipped in the plugin package. */
export default function sessionControls(pi: ExtensionAPI): void {
  let cancelTree = false;
  let startup: 'observe' | 'hold' | 'settle' | 'race' | undefined;
  let releaseStart: (() => void) | undefined;
  let releaseInput: (() => void) | undefined;
  pi.registerCommand('test-start-mode', { description: 'Observe or hold a real Pi startup/settlement', handler: async (args) => { startup = args.trim() as typeof startup; } });
  pi.registerCommand('test-input-release', { description: 'Release the held extension input', handler: async () => { releaseInput?.(); releaseInput = undefined; } });
  pi.on('input', async (event) => {
    if (startup !== 'race' || event.source !== 'extension') return;
    pi.appendEntry('dag-test.start-semantics', { stage: 'input-held' });
    await new Promise<void>((resolve) => { releaseInput = resolve; });
  });
  pi.registerCommand('test-start-release', { description: 'Release the held startup', handler: async () => { releaseStart?.(); releaseStart = undefined; } });
  pi.registerCommand('test-custom-run', { description: 'Start an actual custom-message run', handler: async (content) => { pi.sendMessage({ customType: 'dag-test.custom-start', content: content || 'DP2 custom run', display: false }, { triggerTurn: true }); } });
  pi.on('before_agent_start', async (event, ctx) => {
    if (!startup) return;
    pi.appendEntry('dag-test.start-semantics', { stage: 'before', messageType: event.messageType, hasPrompt: 'prompt' in event, idle: ctx.isIdle(), activeTools: pi.getActiveTools(), sections: event.systemPromptOptions.sections, guidelines: event.systemPromptOptions.promptGuidelines });
    if (startup === 'hold' || startup === 'race') {
      startup = 'observe';
      await new Promise<void>((resolve) => { releaseStart = resolve; });
      pi.appendEntry('dag-test.start-semantics', { stage: 'released', idle: ctx.isIdle() });
    }
  });
  pi.on('context', (event) => { if (startup) pi.appendEntry('dag-test.start-semantics', { stage: 'context', messages: event.messages.map(message => ({ role: message.role, ...('customType' in message ? { customType: message.customType } : {}), ...('content' in message ? { content: message.content } : {}) })) }); });
  pi.on('agent_before_settle', async (event, ctx) => {
    if (startup !== 'settle' || event.outcome !== 'completed') return;
    startup = 'observe';
    pi.appendEntry('dag-test.start-semantics', { stage: 'settling', outcome: event.outcome, signal: ctx.signal?.aborted ?? null });
    await new Promise(resolve => setTimeout(resolve, 450));
  });
  pi.on('agent_settled', (event) => { if (startup) pi.appendEntry('dag-test.start-semantics', { stage: 'settled', aborted: event.aborted }); });
  pi.on('session_before_tree', () => { if (cancelTree) { cancelTree = false; return { cancel: true }; } });
  pi.registerCommand('test-cancel-tree', { description: 'Cancel the next test tree navigation', handler: async () => { cancelTree = true; } });
  pi.registerCommand('test-goal-corrupt', { description: 'Append corrupt Goal for recovery tests', handler: async () => { pi.appendEntry('pi-dag-workflow.goal', { version: 99 }); } });
  pi.registerCommand("test-tree", { description: "Test active-branch navigation", handler: async (args, ctx) => { await ctx.navigateTree(args.trim(), { summarize: false }); } });
  pi.registerCommand("test-reload", { description: "Test actual extension reload", handler: async (_args, ctx) => { await ctx.reload(); } });
  pi.registerCommand("test-corrupt", { description: "Append invalid test state without changing existing history", handler: async () => { pi.appendEntry("pi-dag-workflow.state", { version: 99 }); } });
  pi.registerTool({ name: "test_search", label: "Test search", description: "Offline test search only", parameters: Type.Object({ query: Type.String() }), async execute(_id, params) { return { content: [{ type: "text", text: `offline search: ${params.query}` }], details: undefined }; } });
}
