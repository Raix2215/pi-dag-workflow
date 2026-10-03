import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Fingerprint {
  call: number;
  messages: number;
  checkpoint: boolean;
  fingerprint: string;
  requestMessages: unknown[];
}

/**
 * Test-only memory-style context extension. It owns the provider context transform and keeps a
 * fingerprint of every transformed request next to the session cwd. The checkpoint RPC test uses
 * that log to prove the transform keeps running across compaction and still sees the checkpoint,
 * and never rewrites the persisted prefix.
 */
export default function checkpointMemory(pi: ExtensionAPI): void {
  let call = 0;
  let filtered = false;
  pi.registerCommand('test-filter-checkpoints', { description: 'Test a memory-owned context filter', handler: async () => { filtered = true; } });
  pi.on("context", (event, ctx) => {
    call += 1;
    const messages = event.messages
      .filter((message) => !filtered || message.role !== 'custom' || message.customType !== 'pi-dag-workflow.checkpoint')
      .map((message) => message.role === 'compactionSummary' ? { ...message, summary: `MEMORY-PROJECTION: ${message.summary}` } : message);
    const text = JSON.stringify(messages);
    const fingerprint: Fingerprint = {
      call,
      messages: messages.length,
      requestMessages: messages,
      checkpoint: text.includes("Workflow state checkpoint"),
      fingerprint: text.slice(0, 200),
    };
    appendFileSync(join(ctx.cwd, "checkpoint-memory.jsonl"), `${JSON.stringify(fingerprint)}\n`);
    return { messages };
  });
}
