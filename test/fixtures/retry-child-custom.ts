import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { appendFileSync } from 'node:fs';

/** Native child-process startup probe; never replaces the Agents child entry. */
export default function childCustom(pi: ExtensionAPI): void {
  if (process.env.PI_DAG_CHILD !== '1') return;
  const log = process.env.PI_DAG_TEST_CHILD_CONTEXT_LOG;
  if (!log) return;
  let queued = false;
  pi.on('agent_settled', () => {
    if (queued) return;
    queued = true;
    pi.sendMessage({ customType: 'dag-test.child-custom', content: 'DP2 child custom run', display: false }, { triggerTurn: true });
  });
  pi.on('context', (event) => {
    appendFileSync(log, JSON.stringify({ type: 'child-context', messages: event.messages.map((message) => ({
      role: message.role, ...('customType' in message ? { customType: message.customType } : {}),
      ...('content' in message ? { content: message.content } : {}),
    })) }) + '\n');
  });
  pi.on('before_agent_start', (event, ctx) => {
    appendFileSync(log, JSON.stringify({ type: 'child-start', messageType: event.messageType, idle: ctx.isIdle(),
      tools: pi.getActiveTools(), childSafety: event.systemPromptOptions.sections.dag_child }) + '\n');
  });
}
