import todos from '../src/todos/index.ts';
import plan from '../src/plan/index.ts';
import goal from '../src/goal/index.ts';
import { EventEmitter } from 'node:events';
import { emptyGoalState, GOAL_TYPE, emptyState, GOAL_CHECKPOINT_TYPE, STATE_TYPE, type Feature } from './fixtures/public-records.ts';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { IsolatedClient, sourceEntries, testCli } from './fixtures/isolated-client.ts';
import { execFileSync } from 'node:child_process';


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
  const persist = (message: any) => { const entry = { type: 'custom_message', ...message, timestamp: message.timestamp ?? Date.now() }; entries.push(entry); leaf++; return entry; };
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
  return { entries, sent, ctx, fire, handlers, accept: (drafts: any[]) => drafts.filter(entry => entry.type === 'custom_message').map(persist), idle(value: boolean) { idle = value; },
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
test('final context projects only the current contract, never edits a system/summary/report or wakes a turn', async (t) => {
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
  assert.equal(result.messages[0], leading); assert.equal(result.messages[2], summary); assert.equal(result.messages[3], report);
  assert.equal(result.messages.length, 4); assert.equal(result.messages[1].customType, GOAL_CHECKPOINT_TYPE);
  assert.match(result.messages[1].content, /FINAL-REQUIREMENT/);
  // The next request starts from native history, never the previous hook output.
  assert.deepEqual((await finalContext({ messages: [...original, { role: 'user', content: 'next native message' }] }, ctx)).messages.slice(0, 4), result.messages);
  await h.command('goal', 'disable #1');
  assert.equal(await finalContext({ messages: original }, ctx), undefined);
  assert.equal(h.sent.some(message => message.options?.triggerTurn === true), false);
});

for (const mode of ['native', 'filtered', 'unpersisted-to-native', 'compact'] as const) test(`Goal public assembly keeps append-stable JSON across wakes (${mode})`, async (t) => {
  const h = await host(['goal']); t.after(() => h.close()); h.idle(false);
  const requirement = 'FIRST-REQUIREMENT\n' + 'complete original requirement; '.repeat(120) + '\nLAST-REQUIREMENT';
  await h.call('goal', { action: 'create', title: 'stable objective', description: requirement, maxTurns: 32 });
  await h.fire('input', { source: 'rpc', text: 'enable' });
  assert.ok(!(await h.call('goal', { action: 'enable', id: 1 })).isError);
  const native = (entry: any) => ({ role: 'custom', customType: entry.customType, content: entry.content, display: entry.display, details: entry.details, timestamp: entry.timestamp });
  const system = { role: 'system', content: 'stable native system', timestamp: 1 };
  const summary = { role: 'compactionSummary', summary: 'memory-owned summary', timestamp: 2 };
  const report = { role: 'custom', customType: AGENT_REPORT_MESSAGE, content: 'memory-owned report', timestamp: 3 };
  const other = { role: 'custom', customType: GOAL_CHECKPOINT_TYPE, content: 'Goal #99 paused. Resume only on explicit enable.', timestamp: 4 };
  const history: any[] = [system, summary, report, other, { role: 'user', content: 'stable native history', timestamp: 5 }];
  if (mode === 'native' || mode === 'filtered') history.push(...(await h.prompt()).messages.map(native));
  if (mode === 'compact') {
    await h.prompt();
    await h.fire('session_before_compact', { willRetry: true });
    await h.fire('session_compact');
  }
  const frames: any[][] = [];
  let recoveries = 0;
  for (let frame = 0; frame < 7; frame++) {
    await h.fire('turn_start');
    // Native history is independent of either hook's result; only real boundary drafts are accepted.
    const incoming = history.filter(message => mode !== 'filtered' || message.customType !== GOAL_CHECKPOINT_TYPE || message === other);
    if (mode === 'unpersisted-to-native') assert.equal(incoming.some(message => message.customType === GOAL_CHECKPOINT_TYPE && message.content.startsWith('Goal contract (')), frame >= 3, 'the fixture really crosses a successful visible persistence boundary');
    const snapshot = structuredClone(incoming);
    const ordinary = await h.fire('context', { messages: incoming });
    recoveries += ordinary.messages.filter((message: any) => !incoming.includes(message) && message.customType === GOAL_CHECKPOINT_TYPE).length;
    const { messages } = await h.fire('context_with_system', { messages: ordinary.messages });
    assert.deepEqual(incoming, snapshot, 'hooks never mutate native messages');
    const contracts = messages.filter((message: any) => message.customType === GOAL_CHECKPOINT_TYPE && message.content.startsWith('Goal contract ('));
    assert.equal(contracts.length, 1, 'every request has exactly one complete current contract');
    const contract = contracts[0];
    assert.ok(contract.content.includes(JSON.stringify(requirement)), 'complete original requirements survive');
    assert.ok(contract.content.includes(GOAL_EXECUTION_RULE));
    assert.equal(Object.hasOwn(JSON.parse(contract.content.split('\n')[1]).run, 'used'), false, 'used is authoritative state, not contract identity');
    assert.equal(messages.indexOf(contract), mode === 'native' ? 5 : 1, 'projection never floats at the active tail');
    assert.equal(messages[0], system); assert.ok(messages.includes(summary)); assert.ok(messages.includes(report)); assert.ok(messages.includes(other));
    frames.push(structuredClone(messages));
    assert.equal((await h.call('goal', { action: 'get', id: 1 })).details.goalState.run.used, frame, 'public continuation still counts every wake');
    await h.call('goal', { action: 'update', progress: `verified-${frame}`, nextStep: `next-${frame}` });
    const persist = mode === 'native' || mode === 'filtered' || mode === 'unpersisted-to-native' && frame >= 2;
    const accept = (drafts: any[]) => h.accept(drafts.filter((entry: any) => persist || entry.customType !== GOAL_CHECKPOINT_TYPE)).map(native);
    const boundary = await h.fire('turn_end', { outcome: 'completed', entries: [] });
    history.push({ role: 'assistant', content: `native answer ${frame}`, timestamp: 10 + frame }, ...accept(boundary.entries));
    const settle = await h.fire('agent_before_settle', { outcome: 'completed', entries: [] });
    history.push(...accept(settle.entries));
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  for (let frame = 1; frame < frames.length; frame++) {
    const position = mode === 'native' ? 5 : 1;
    assert.equal(frames[frame]![position].timestamp, frames[0]![position].timestamp, 'timestamp survives time and persistence transitions');
    assert.equal(frames[frame]![position].content, frames[0]![position].content, 'wake usage/notes never rewrite the contract');
    assert.equal(JSON.stringify(frames[frame]!.slice(0, frames[frame - 1]!.length)), JSON.stringify(frames[frame - 1]), `frame ${frame}: full message JSON is pure-append`);
  }
  assert.equal(recoveries, mode === 'compact' ? 1 : 0, 'ordinary compaction recovery is strictly once');
  // Successful compaction is a new native baseline, including when a projection already exists.
  await h.fire('session_before_compact', { willRetry: true }); await h.fire('session_compact');
  const rebuiltHistory: any[] = [system, summary, { role: 'user', content: 'post-compaction native history', timestamp: 100 }];
  const rebuilt: any[][] = [];
  let rebuiltRecoveries = 0;
  for (let frame = 0; frame < 7; frame++) {
    const ordinary = await h.fire('context', { messages: [...rebuiltHistory] });
    rebuiltRecoveries += ordinary.messages.length - rebuiltHistory.length;
    const final = await h.fire('context_with_system', { messages: ordinary.messages });
    assert.equal(final.messages[1].customType, GOAL_CHECKPOINT_TYPE);
    assert.ok(final.messages[1].content.includes(JSON.stringify(requirement)));
    assert.equal(final.messages.filter((message: any) => message.customType === GOAL_CHECKPOINT_TYPE).length, 1);
    rebuilt.push(structuredClone(final.messages));
    rebuiltHistory.push({ role: 'assistant', content: `post-compaction native answer ${frame}`, timestamp: 101 + frame });
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  assert.equal(rebuiltRecoveries, 1, 'each successful compaction arms exactly one ordinary recovery');
  assert.notEqual(rebuilt[0]![1].timestamp, frames[0]![mode === 'native' ? 5 : 1].timestamp, 'compaction retires the previous projection');
  for (let frame = 1; frame < rebuilt.length; frame++) assert.equal(JSON.stringify(rebuilt[frame]!.slice(0, rebuilt[frame - 1]!.length)), JSON.stringify(rebuilt[frame - 1]), 'first ordinary recover and subsequent final fallbacks share one stable position/timestamp');
  // A real definition/policy change is a new baseline, not a claimed pure append.
  await h.fire('input', { source: 'rpc', text: 'authorized definition change' });
  await h.call('goal', { action: 'update', description: 'CHANGED-REQUIREMENT', maxTurns: 40 });
  const changed = (await h.fire('context_with_system', { messages: history })).messages;
  assert.ok(changed.some((message: any) => message.customType === GOAL_CHECKPOINT_TYPE && message.content.includes('CHANGED-REQUIREMENT') && message.content.includes('"limit":"40"')));
  assert.equal(changed.filter((message: any) => message.customType === GOAL_CHECKPOINT_TYPE && message.content.startsWith('Goal contract (')).length, 1, 'a changed definition never leaves the previous full contract live beside it');
  for (const [command, marker] of [['nopause', 'nopause: do not ask'], ['nolimit', '"nolimit":true'], ['autoresearch', 'autoresearch: continuously research']]) {
    await h.command('goal', `${command} #1 on`);
    const updated = (await h.fire('context_with_system', { messages: rebuiltHistory })).messages;
    assert.ok(updated[1].content.includes(marker));
    assert.ok(updated[1].content.includes('CHANGED-REQUIREMENT'));
  }
  const beforeRestore = (await h.fire('context_with_system', { messages: rebuiltHistory })).messages[1];
  await new Promise(resolve => setTimeout(resolve, 3));
  await h.fire('session_tree');
  assert.equal((await h.call('goal', { action: 'get', id: 1 })).details.goalState.run.paused, true, 'real tree restoration never resumes Goal');
  assert.deepEqual((await h.fire('context_with_system', { messages: [system, summary] })).messages, [system, summary], 'restoration cannot replay the previous projection');
  await h.fire('input', { source: 'rpc', text: 'enable restored branch' });
  await h.call('goal', { action: 'enable', id: 1 });
  const restored = (await h.fire('context_with_system', { messages: [system, summary] })).messages;
  assert.equal(restored.length, 3); assert.match(restored[1].content, /CHANGED-REQUIREMENT/);
  assert.notEqual(restored[1].timestamp, beforeRestore.timestamp, 'tree restoration clears the old projection even for the same definition');
  assert.equal(h.sent.some(message => message.options?.triggerTurn === true), false);
});

test('projection retires only the focused Goal\'s old full contract after a definition change', async (t) => {
  const h = await host(['goal']); t.after(() => h.close()); h.idle(false);
  await h.call('goal', { action: 'create', title: 'stable objective', description: 'OLD-DEFINITION' });
  await h.fire('input', { source: 'rpc', text: 'enable' });
  assert.ok(!(await h.call('goal', { action: 'enable', id: 1 })).isError);
  const native = (entry: any) => ({ role: 'custom', customType: entry.customType, content: entry.content, display: entry.display, details: entry.details, timestamp: entry.timestamp });
  const saved = (await h.prompt()).messages.map(native);
  assert.equal(saved.length, 1); assert.match(saved[0]!.content, /OLD-DEFINITION/);
  // A second real Goal produces a native full contract that the focused Goal's projection must not retire.
  await h.call('goal', { action: 'create', title: 'other objective', description: 'OTHER-DEFINITION' });
  await h.fire('input', { source: 'rpc', text: 'enable other Goal' });
  assert.ok(!(await h.call('goal', { action: 'enable', id: 2 })).isError);
  const otherContract = (await h.prompt()).messages.map(native);
  assert.equal(otherContract.length, 1); assert.match(otherContract[0]!.content, /OTHER-DEFINITION/);
  assert.equal(JSON.parse(otherContract[0]!.content.split('\n')[1]!).goal.id, 2);
  await h.fire('input', { source: 'rpc', text: 'enable focused Goal' });
  assert.ok(!(await h.call('goal', { action: 'enable', id: 1 })).isError);
  const system = { role: 'system', content: 'stable native system', timestamp: 1 };
  const summary = { role: 'compactionSummary', summary: 'memory-owned summary', timestamp: 2 };
  const report = { role: 'custom', customType: AGENT_REPORT_MESSAGE, content: 'memory-owned report', timestamp: 3 };
  const other = { role: 'custom', customType: GOAL_CHECKPOINT_TYPE, content: 'Goal #99 paused: other Goal. Resume only on explicit enable.', timestamp: 4 };
  const history = [system, summary, report, other, ...saved, ...otherContract, { role: 'user', content: 'definition update', timestamp: 5 }];
  await h.fire('input', { source: 'rpc', text: 'authorized definition change' });
  await h.call('goal', { action: 'update', description: 'NEW-DEFINITION' });
  const before = structuredClone(history);
  const messages = (await h.fire('context_with_system', { messages: history })).messages;
  assert.deepEqual(history, before, 'model-view coordination never mutates native history');
  const contracts = messages.filter((message: any) => message.customType === GOAL_CHECKPOINT_TYPE && message.content.startsWith('Goal contract ('));
  const focused = contracts.filter((message: any) => JSON.parse(message.content.split('\n')[1]!).goal.id === 1);
  assert.equal(focused.length, 1, 'the superseded current-Goal definition is not a second live focused contract');
  assert.equal(messages.indexOf(focused[0]), 1);
  assert.match(focused[0].content, /NEW-DEFINITION/);
  assert.ok(!focused[0].content.includes('OLD-DEFINITION'));
  assert.ok(messages.includes(otherContract[0]), 'another Goal\'s full native contract is not retired');
  assert.match(otherContract[0]!.content, /OTHER-DEFINITION/);
  assert.equal(messages[0], system); assert.ok(messages.includes(summary)); assert.ok(messages.includes(report)); assert.ok(messages.includes(other), 'the other Goal paused reminder is not dropped');
  assert.ok(h.entries.some((entry: any) => entry.content?.includes('OLD-DEFINITION')), 'native branch history still owns the previous definition');
  const next = (await h.fire('context_with_system', { messages: [...history, { role: 'assistant', content: 'native answer' }, { role: 'user', content: 'next request' }] })).messages;
  assert.equal(JSON.stringify(next.slice(0, messages.length)), JSON.stringify(messages), 'the replacement projection stays at one fixed position');
});

test('legacy native contract keeps its historical used field and append stability without a projection', async (t) => {
  const h = await host(['goal']); t.after(() => h.close()); h.idle(false);
  await h.call('goal', { action: 'create', title: 'legacy objective', description: 'LEGACY-REQUIREMENT' });
  await h.fire('input', { source: 'rpc', text: 'enable' });
  assert.ok(!(await h.call('goal', { action: 'enable', id: 1 })).isError);
  const native = (entry: any) => ({ role: 'custom', customType: entry.customType, content: entry.content, display: entry.display, details: entry.details, timestamp: entry.timestamp });
  const saved = (await h.prompt()).messages.map(native)[0];
  assert.ok(saved);
  const lines = saved.content.split('\n'); const payload = JSON.parse(lines[1]); payload.run.used = 12; lines[1] = JSON.stringify(payload);
  const legacy = { ...saved, content: lines.join('\n') };
  const system = { role: 'system', content: 'stable native system', timestamp: 1 }; const first = { role: 'user', content: 'native request', timestamp: 2 };
  const firstHistory = [system, legacy, first];
  const firstResult = await h.fire('context_with_system', { messages: firstHistory });
  assert.equal(firstResult.messages, firstHistory, 'a current legacy contract is not rewritten or duplicated');
  assert.ok(legacy.content.includes('"used":12'));
  const secondHistory = [...firstHistory, { role: 'assistant', content: 'native answer', timestamp: 3 }, { role: 'user', content: 'next native request', timestamp: 4 }];
  const secondResult = await h.fire('context_with_system', { messages: secondHistory });
  assert.equal(secondResult.messages, secondHistory, 'legacy history stays a pure-append baseline');
  await h.fire('input', { source: 'rpc', text: 'authorized definition change' });
  await h.call('goal', { action: 'update', description: 'REVISED-REQUIREMENT' });
  const revised = (await h.fire('context_with_system', { messages: secondHistory })).messages;
  const contracts = revised.filter((message: any) => message.customType === GOAL_CHECKPOINT_TYPE && message.content.startsWith('Goal contract ('));
  assert.equal(contracts.length, 1); assert.equal(revised.indexOf(contracts[0]), 1);
  assert.match(contracts[0].content, /REVISED-REQUIREMENT/);
  assert.equal(Object.hasOwn(JSON.parse(contracts[0].content.split('\n')[1]).run, 'used'), false, 'newly generated contracts never reintroduce used');
  assert.ok(h.entries.some((entry: any) => entry.content === saved.content && entry.content.includes('LEGACY-REQUIREMENT')), 'the branch-owned legacy contract is retained, not rewritten');
});

for (const memoryFirst of [true, false]) test(`actual Pi: short wakes keep complete requirements even when ordinary memory hides all contracts (${memoryFirst ? 'before' : 'after'} workflow)`, { timeout: 30000 }, async (t) => {
  const memory = new URL('./fixtures/goal-compaction.ts', import.meta.url).pathname;
  const client = await IsolatedClient.start(undefined, 'missing-contract-final', memoryFirst ? [] : [memory], ['--dag-test-context-export', '--dag-test-goal-tool-rounds', '6'], false, memoryFirst ? [memory, ...sourceEntries] : undefined); t.after(() => client.close());
  t.diagnostic(`CLI ${execFileSync(process.execPath, [testCli(), '--version'], { encoding: 'utf8' }).trim()}; extensions: ${memoryFirst ? 'goal-compaction, todos, plan, agents, goal, retry, offline-model' : 'todos, plan, agents, goal, retry, offline-model, goal-compaction'}; scripted provider, no paid model`);
  await client.prompt('/test-hide-goal-contract');
  await client.prompt('TEST CALL goal {"action":"create","title":"预算测试","description":"FINAL-REQUIREMENT","maxTurns":3}');
  const enableOffset = client.records.length;
  await client.prompt('/goal enable #1');
  await client.until(() => client.records.some((record) => record.method === 'notify' && String(record.message).includes('轮上限')));
  const entries = await client.entries() as any[];
  const state = entries.findLast((entry) => entry.customType === GOAL_TYPE).data;
  assert.equal(state.run.used, 3); assert.equal(state.run.paused, true);
  let completedTools = 0, maxToolsInRun = 0;
  for (const record of client.records.slice(enableOffset)) {
    if (record.type === 'agent_start') completedTools = 0;
    if (record.type === 'tool_execution_end' && record.toolName === 'goal') completedTools++;
    if (record.type === 'agent_settled') maxToolsInRun = Math.max(maxToolsInRun, completedTools);
  }
  assert.ok(maxToolsInRun >= 6, 'real Pi finishes at least six tool round trips inside a single agent run');
  const text = (message: any) => typeof message.content === 'string' ? message.content : (message.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
  const runs: { used: number; messages: any[] }[] = [];
  let current: any;
  for (const entry of entries) {
    if (entry.customType === GOAL_TYPE) current = entry.data;
    if (entry.customType === 'dag-test.context-export' && current && !current.run.paused) runs.push({ used: current.run.used, messages: entry.data.context.messages });
  }
  assert.ok(entries.some(entry => entry.customType === GOAL_CHECKPOINT_TYPE && entry.content.includes('FINAL-REQUIREMENT')), 'before_agent_start/native boundary really persists the full contract');
  assert.deepEqual([...new Set(runs.map(run => run.used))], [1, 2, 3], 'real wakes still consume their authoritative budgets');
  t.diagnostic(JSON.stringify({ frames: runs.length, framesPerWake: [1, 2, 3].map(used => runs.filter(run => run.used === used).length), maxToolsInRun }));
  for (const used of [1, 2, 3]) {
    const frames = runs.filter(run => run.used === used);
    assert.ok(frames.length >= 7, `wake ${used}: at least six consecutive serial tool round trips in one run`);
    assert.equal(frames.at(-1)!.messages.filter(message => message.role === 'toolResult').length - frames[0]!.messages.filter(message => message.role === 'toolResult').length, 6);
  }
  for (const { messages } of runs) {
    assert.ok(messages.some((message: any) => text(message).startsWith('Goal contract (') && text(message).includes('FINAL-REQUIREMENT') && text(message).includes('verify every requirement')));
    assert.equal(messages[0].role, 'system');
    assert.equal(messages.findIndex(message => text(message).startsWith('Goal contract (')), 1);
    assert.equal(messages.filter(message => text(message).startsWith('Goal contract (')).length, 1);
    assert.ok(messages.every((message: any) => !Object.keys(message.sections ?? {}).some((key) => key.startsWith('dag_workflow'))));
  }
  for (let frame = 1; frame < runs.length; frame++) assert.equal(JSON.stringify(runs[frame]!.messages.slice(0, runs[frame - 1]!.messages.length)), JSON.stringify(runs[frame - 1]!.messages), 'full provider-facing JSON stays pure-append, including timestamps and across used changes');
  assert.ok(!entries.some((entry) => entry.customType === GOAL_RETRY_MESSAGE));
  // An explicitly changed definition is a new baseline, never silently labelled pure append.
  await client.prompt('TEST CALL goal {"action":"update","id":1,"description":"REVISED-REQUIREMENT","maxTurns":1}');
  const changedAt = client.records.length;
  await client.prompt('/goal enable #1');
  await client.until(() => client.records.slice(changedAt).some(record => record.method === 'notify' && String(record.message).includes('轮上限')));
  const revisedEntries = await client.entries() as any[];
  const revised = revisedEntries.filter(entry => entry.customType === 'dag-test.context-export' && entry.data.context.messages.some((message: any) => text(message).startsWith('Goal contract (') && text(message).includes('REVISED-REQUIREMENT'))).map(entry => entry.data.context.messages);
  assert.ok(revised.length >= 7);
  for (let index = 1; index < revised.length; index++) assert.equal(JSON.stringify(revised[index].slice(0, revised[index - 1].length)), JSON.stringify(revised[index - 1]), 'new definition has its own stable baseline');
  assert.notEqual(text(revised[0][1]), text(runs[0]!.messages[1]));
  assert.ok(!text(revised[0][1]).includes('FINAL-REQUIREMENT'));
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
