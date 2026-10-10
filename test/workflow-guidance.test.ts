import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWorkflow } from '../src/workflow/index.ts';
import { emptyState, STATE_TYPE } from '../src/todos/state.ts';
import type { Feature } from '../src/workflow/features.ts';
import { GOAL_EXECUTION_RULE, GOAL_CHECKPOINT_TYPE } from '../src/goal/prompt.ts';

async function host(features: Feature[], initial: any[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'dag-passive-guidance-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  const handlers = new Map<string, Function[]>(), commands = new Map<string, any>(), tools = new Map<string, any>();
  const entries = structuredClone(initial); let leaf = 1; let idle = true;
  const sent: any[] = [];
  const persist = (message: any) => { entries.push({ type: 'custom_message', ...message }); leaf++; };
  const pi: any = {
    on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerFlag() {}, getFlag() {},
    appendEntry(customType: string, data: unknown) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); leaf++; },
    sendMessage(message: any, options: any) { sent.push({ message, options }); persist(message); },
    sendUserMessage() { throw new Error('unexpected wake'); }, getActiveTools: () => ['read', 'todo', 'goal'], getAllTools: () => [...tools.values()],
  };
  const ctx: any = { cwd: root, mode: 'rpc', hasUI: true, isIdle: () => idle,
    sessionManager: { getBranch: () => [...entries], getLeafId: () => String(leaf), getSessionFile: () => undefined },
    ui: { notify() {}, setWidget() {}, select: async (_title: string, options: string[]) => options[1] },
  };
  const workflow = createWorkflow(pi);
  for (const feature of features) await workflow.attach(feature, pi);
  const fire = async (name: string, data: any = {}) => {
    for (const handler of handlers.get(name) ?? []) {
      const result = await handler(data, ctx);
      if (result?.entries) data.entries = result.entries;
      if (result?.messages) data.messages = result.messages;
      if (result?.message) persist(result.message);
    }
    return data;
  };
  await fire('session_start');
  return { entries, sent, ctx, fire, idle(value: boolean) { idle = value; },
    async prompt() { const start = entries.length; const event = await fire('before_agent_start', { systemPromptOptions: { sections: {}, selectedTools: ['read', 'todo', 'goal'] } }); return { event, messages: entries.slice(start).filter((entry: any) => entry.type === 'custom_message') }; },
    command: (name: string, args: string) => commands.get(name).handler(args, ctx),
    call: (name: string, params: any) => tools.get(name).execute('guide-test', params, undefined, undefined, ctx),
    async close() { await fire('session_shutdown'); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); },
  };
}

for (const features of [['plan'], ['todos'], ['todos', 'plan'], ['plan', 'todos']] as Feature[][]) test(`passive guidance respects module isolation and adds no empty Normal notice (${features.join('+')})`, async () => {
  const h = await host(features);
  try {
    const first = await h.prompt();
    assert.deepEqual(first.event.systemPromptOptions.sections, {});
    assert.equal(first.messages.length, 0);
    if (features.includes('plan')) {
      await h.command('plan', 'start');
      const entered = await h.prompt();
      const mode = entered.messages.find((entry: any) => entry.customType === 'pi-dag-workflow.guidance');
      assert.ok(mode); assert.match(mode.content, /Plan: read\/search\/ask/);
      assert.equal(mode.content.includes('Todo definitions'), features.includes('todos'));
      assert.doesNotMatch(mode.content, /Goal/);
      assert.equal((await h.prompt()).messages.length, 0, 'stable mode does not churn');
      await h.command('plan', 'off');
      assert.match((await h.prompt()).messages.find((entry: any) => entry.customType === 'pi-dag-workflow.guidance').content, /Normal:/);
      assert.equal(h.sent.length, 0, 'mode commands and prompt messages do not request a run');
    }
  } finally { await h.close(); }
});

test('Plan-only restores and recovers its mode without a Todo checkpoint dependency', async () => {
  const h = await host(['plan'], [{ type: 'custom', customType: STATE_TYPE, data: { ...emptyState(), plan: true } }]);
  try {
    assert.match((await h.prompt()).messages[0].content, /Plan:/);
    await h.fire('session_compact', {});
    const summary = { role: 'compactionSummary', summary: 'memory owner' };
    const event = await h.fire('context', { messages: [summary] });
    assert.equal(event.messages[0], summary);
    assert.match(event.messages[1].content, /Plan:/);
    const next = await h.fire('turn_end', { outcome: 'completed', entries: [] });
    assert.equal(next.entries.length, 1, 'request-local guidance still gets normal persistence');
    assert.equal(next.continue, undefined);
    assert.equal(h.sent.length, 0);
  } finally { await h.close(); }
});

test('Goal-only has no extra system section; progress is not another full contract', async () => {
  const h = await host(['goal']); h.idle(false);
  try {
    await h.call('goal', { action: 'create', title: 'original', description: 'TAIL-REQUIREMENT' });
    await h.fire('input', { source: 'rpc', text: 'enable' });
    await h.call('goal', { action: 'enable', id: 1 });
    const first = await h.prompt();
    assert.deepEqual(first.event.systemPromptOptions.sections, {});
    assert.equal(first.messages.length, 1);
    assert.ok(first.messages[0].content.includes(GOAL_EXECUTION_RULE));
    assert.match(first.messages[0].content, /TAIL-REQUIREMENT/);
    await h.call('goal', { action: 'update', progress: 'new evidence', nextStep: 'next action' });
    assert.equal((await h.prompt()).messages.length, 0);
    await h.fire('input', { source: 'rpc', text: 'authorized definition change' });
    await h.call('goal', { action: 'update', description: 'NEW-TAIL-REQUIREMENT' });
    const changed = (await h.prompt()).messages;
    assert.equal(changed.length, 1); assert.match(changed[0].content, /NEW-TAIL-REQUIREMENT/);
    await h.command('goal', 'disable #1');
    const paused = (await h.prompt()).messages;
    assert.equal(paused.length, 1); assert.match(paused[0].content, /paused.*explicit enable/);
    assert.ok(!paused[0].content.includes(GOAL_EXECUTION_RULE));
  } finally { await h.close(); }
});

test('discarded Goal boundary drafts are not mistaken for persistence', async () => {
  const h = await host(['goal']); h.idle(false);
  try {
    await h.call('goal', { action: 'create', title: 'original', description: 'COMPLETE-REQUIREMENT' });
    await h.fire('input', { source: 'rpc', text: 'enable' }); await h.call('goal', { action: 'enable', id: 1 });
    const draft = await h.fire('turn_end', { outcome: 'completed', entries: [] });
    const old = draft.entries.find((entry: any) => entry.customType === GOAL_CHECKPOINT_TYPE);
    assert.ok(old);
    const retried = (await h.prompt()).messages.find((entry: any) => entry.customType === GOAL_CHECKPOINT_TYPE);
    assert.equal(retried.details.checkpointId, old.details.checkpointId);
    assert.equal((await h.prompt()).messages.length, 0);
  } finally { await h.close(); }
});
