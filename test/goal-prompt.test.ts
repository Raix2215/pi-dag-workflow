import todos from '../src/todos/index.ts';
import plan from '../src/plan/index.ts';
import goal from '../src/goal/index.ts';
import { EventEmitter } from 'node:events';
import { emptyGoalState, GOAL_TYPE, emptyState, GOAL_CHECKPOINT_TYPE, STATE_TYPE, type Feature } from './fixtures/public-records.ts';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { IsolatedClient, sourceEntries } from './fixtures/isolated-client.ts';


import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_REPORT_MESSAGE, GOAL_RETRY_MESSAGE, GOAL_CONTINUE_MESSAGE } from './fixtures/public-records.ts';

const GOAL_EXECUTION_RULE = "Preserve the full original objective, required outcome and existing permission; progress/nextStep are notes, not scope or permission changes. Implement, experiment and verify every requirement before goal complete. Difficulty, delay, uncertainty, failed attempts, final answers or closed Todos are not completion. Check evidence, challenge blockers and act on alternatives.";
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
  const bus = new EventEmitter();
  pi.events = { emit: (name: string, data: unknown) => bus.emit(name, data), on(name: string, handler: (...args: any[]) => void) { bus.on(name, handler); return () => bus.off(name, handler); } };
  const factories = { todos, plan, goal };
  for (const feature of features) await factories[feature as keyof typeof factories](pi);
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
  return { entries, sent, ctx, fire, handlers, idle(value: boolean) { idle = value; },
    async prompt() { const start = entries.length; const event = await fire('before_agent_start', { systemPromptOptions: { sections: {}, selectedTools: ['read', 'todo', 'goal'] } }); return { event, messages: entries.slice(start).filter((entry: any) => entry.type === 'custom_message') }; },
    command: (name: string, args: string) => commands.get(name).handler(args, ctx),
    call: (name: string, params: any) => tools.get(name).execute('guide-test', params, undefined, undefined, ctx),
    async close() { await fire('session_shutdown'); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); },
  };
}





// goal-prompt.test.ts


// audit-goal-prompt.test.ts
{
test('actual Pi: idle Goal enable after Plan uses fresh Normal/Goal guidance and acceptance description', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(); t.after(() => client.close());
  await client.prompt('TEST CALL goal {"action":"create","title":"完成测试","description":"附加验收要求","maxTurns":2}');
  await client.prompt('/plan start'); await client.prompt('只读探索');
  await client.prompt('/plan off');
  const offset = client.records.length;
  await client.send('prompt', { message: '/goal enable 1' });
  await client.until(() => client.records.slice(offset).some((record) => record.type === 'agent_settled'));
  const entries = await client.entries() as any[];
  const system = entries.findLast((entry) => entry.message?.role === 'system');
  assert.ok(!Object.keys(system.message.sections ?? {}).some((key) => key.startsWith('dag_workflow')));
  const mode = entries.findLast((entry) => entry.customType === 'pi-dag-workflow.guidance');
  assert.match(mode.content, /Normal: continue the existing Todo list/);
  assert.match(mode.content, /Goal stays paused until explicitly enabled/);
  const checkpoint = entries.find((entry) => entry.customType === 'pi-dag-workflow.goal-checkpoint' && entry.content.includes('"paused":false'));
  assert.match(checkpoint.content, /附加验收要求/);
  assert.match(checkpoint.content, /verify every requirement/);
  assert.equal(entries.findLast((entry) => entry.customType === 'pi-dag-workflow.goal').data.goals[0].status, 'completed');
});
}

// goal-context-cost.test.ts
{
let contextClient: IsolatedClient | undefined;
after(async () => { await contextClient?.close(); });
for (const nopause of [false, true]) test(`real Pi: bounded ${nopause ? 'nopause' : 'ordinary'} Goal exposes repeatable context sizes without claiming model tokens`, { timeout: 30000 }, async (t) => {
  if (!contextClient) contextClient = await IsolatedClient.start(undefined, 'goal-context-cost', [], ['--dag-test-context-metrics']);
  else { await contextClient.send('new_session'); contextClient.records.length = 0; }
  const client = contextClient;
  await client.prompt('TEST CALL goal {"action":"create","title":"预算测试","maxTurns":6}');
  if (nopause) {
    await client.prompt('/goal nopause #1 on');
  }
  await client.prompt('/goal enable #1');
  await client.until(() => client.records.some((record) => (record.entry as any)?.customType === GOAL_TYPE && (record.entry as any).data.run.reason?.includes('轮上限')));
  const entries = await client.entries() as any[];
  const wakes = entries.filter((entry) => entry.customType === GOAL_CONTINUE_MESSAGE);
  assert.equal(wakes.length, 5);
  assert.ok(wakes.every((entry) => entry.content.includes('Continue the full original Goal under its current contract.')));
  assert.ok(wakes.every((entry) => !entry.content.includes(GOAL_EXECUTION_RULE)), 'wakes use the approved compact reminder');
  const metrics = entries.filter((entry) => entry.customType === 'dag-test.context-metrics').map((entry) => entry.data);
  const rules = metrics.map((entry) => entry.messages.reduce((sum: number, message: any) => sum + message.executionRules + message.sectionExecutionRules, 0));
  assert.equal(Math.max(...rules), 1, 'full rules occur only in the checkpoint, not the system or every wake');
  assert.ok(metrics.every((entry) => entry.messages.every((message: any) => message.sectionExecutionRules === 0)), 'no Goal rules in system sections');
  assert.ok(metrics.every((entry) => Number.isInteger(entry.contextBytes) && entry.contextBytes > 0));
  t.diagnostic(JSON.stringify({ mode: nopause ? 'nopause' : 'ordinary', wakeChars: wakes.map((entry) => entry.content.length), wakeBytes: wakes.map((entry) => Buffer.byteLength(entry.content)), contextBytes: metrics.map((entry) => entry.contextBytes), ruleOccurrences: rules, systemBytes: [...new Set(metrics.map((entry) => entry.systemBytes))], toolsBytes: [...new Set(metrics.map((entry) => entry.toolsBytes))] }));
});
}

// goal-contract-visibility.test.ts
{
test('final context appends only the current contract, never edits a system/summary/report or wakes a turn', async (t) => {
  const saved = { ...emptyGoalState(), nextId: 2, focusId: 1, goals: [{ id: 1, title: 'current objective', description: 'FINAL-REQUIREMENT', status: 'active', maxTurns: 32, createdAt: 1 }], run: { paused: false, used: 0, stalled: 0 } };
  const h = await host(['goal'], [{ type: 'custom', customType: GOAL_TYPE, data: saved }]); t.after(() => h.close()); h.idle(false);
  const { handlers, ctx } = h;
  // Public restoration must pause; explicit input and the registered tool re-enable the Goal.
  assert.equal((await h.call('goal', { action: 'list' })).details.goalState.run.paused, true);
  const leading = { role: 'system', content: 'native prompt', sections: { rules: 'native rules' } };
  const finalContext = handlers.get('context_with_system')![0]!;
  assert.equal(await finalContext({ messages: [leading] }, ctx), undefined);
  for (const handler of handlers.get('input') ?? []) await handler({ source: 'rpc', text: 'explicitly enable' }, ctx);
  assert.ok(!(await h.call('goal', { action: 'enable', id: 1 })).isError);
  const summary = { role: 'compactionSummary', summary: 'owned by memory' };
  const report = { role: 'custom', customType: AGENT_REPORT_MESSAGE, content: 'do not replay or edit' };
  const original = [leading, summary, report];
  const result = await finalContext({ messages: original }, ctx);
  assert.deepEqual(original, [leading, summary, report]);
  assert.equal(result.messages[0], leading); assert.equal(result.messages[1], summary); assert.equal(result.messages[2], report);
  assert.equal(result.messages.length, 4); assert.equal(result.messages[3].customType, GOAL_CHECKPOINT_TYPE);
  assert.match(result.messages[3].content, /FINAL-REQUIREMENT/);
  assert.equal(await finalContext({ messages: result.messages }, ctx), undefined);
  await h.command('goal', 'disable #1');
  assert.equal(await finalContext({ messages: original }, ctx), undefined);
  assert.equal(h.sent.some(message => message.options?.triggerTurn === true), false);
});

for (const memoryFirst of [true, false]) test(`actual Pi: short wakes keep complete requirements even when ordinary memory hides all contracts (${memoryFirst ? 'before' : 'after'} workflow)`, { timeout: 30000 }, async (t) => {
  const memory = new URL('./fixtures/goal-compaction.ts', import.meta.url).pathname;
  const client = await IsolatedClient.start(undefined, 'missing-contract-final', memoryFirst ? [] : [memory], ['--dag-test-context-export'], false, memoryFirst ? [memory, ...sourceEntries] : undefined); t.after(() => client.close());
  await client.prompt('/test-hide-goal-contract');
  await client.prompt('TEST CALL goal {"action":"create","title":"预算测试","description":"FINAL-REQUIREMENT","maxTurns":3}');
  await client.prompt('/goal enable #1');
  await client.until(() => client.records.some((record) => record.method === 'notify' && String(record.message).includes('轮上限')));
  const entries = await client.entries() as any[];
  const state = entries.findLast((entry) => entry.customType === GOAL_TYPE).data;
  assert.equal(state.run.used, 3); assert.equal(state.run.paused, true);
  const text = (message: any) => typeof message.content === 'string' ? message.content : (message.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
  const runs: any[][] = [];
  let current: any;
  for (const entry of entries) {
    if (entry.customType === GOAL_TYPE) current = entry.data;
    if (entry.customType === 'dag-test.context-export' && current && !current.run.paused) runs.push(entry.data.context.messages);
  }
  assert.ok(runs.length >= 3);
  for (const messages of runs) {
    assert.ok(messages.some((message: any) => text(message).startsWith('Goal contract (') && text(message).includes('FINAL-REQUIREMENT') && text(message).includes('verify every requirement')));
    assert.equal(messages[0].role, 'system');
    assert.ok(messages.every((message: any) => !Object.keys(message.sections ?? {}).some((key) => key.startsWith('dag_workflow'))));
  }
  assert.ok(!entries.some((entry) => entry.customType === GOAL_RETRY_MESSAGE));
});
}

// workflow-guidance.test.ts
{

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
}
