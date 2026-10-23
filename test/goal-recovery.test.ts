import { type GoalParams } from './fixtures/public-records.ts';
import { GOAL_TYPE, type GoalState, STATE_TYPE, AGENTS_TYPE } from './fixtures/public-records.ts';
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { loadPublic } from './fixtures/public-host.ts';


import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from 'node:timers/promises';
import { IsolatedClient } from "./fixtures/isolated-client.ts";

import { stripTerminalSequences } from "@earendil-works/pi-tui";


import { rm } from "node:fs/promises";
import { AGENT_REPORT_MESSAGE, GOAL_RETRY_MESSAGE, GOAL_CONTINUE_MESSAGE, RETRY_REQUEST_MESSAGE } from './fixtures/public-records.ts';

/** Simulated public extension events, separate from the actual offline Pi cases below. */
async function goalHost() {
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const entries: any[] = []; const wakes: any[] = [];
  let sequence = 0;
  const ctx: any = {
    cwd: tmpdir(), mode: 'rpc', hasUI: false, signal: undefined, isIdle: () => true,
    sessionManager: { getBranch: () => entries, getLeafId: () => String(entries.length), getSessionFile: () => '/tmp/d5-goal-recovery-session.jsonl' },
    ui: { notify() {}, setWidget() {}, setStatus() {} },
  };
  const pi: any = {
    on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {},
    appendEntry(customType: string, data: any) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); },
    sendMessage(message: any, options: any) { if (options?.triggerTurn) wakes.push(message); },
    sendUserMessage(message: string) { wakes.push(message); },
  };
  await loadPublic(pi, ['goal'], 'zh-CN');
  const fire = async (name: string, event: any = {}) => {
    if (name === 'turn_end' || name === 'agent_before_settle') event.entries ??= [];
    for (const handler of handlers.get(name) ?? []) {
      const result = await handler(event, ctx);
      if (result?.entries) event.entries = result.entries;
      if (result?.continue !== undefined) event.continue = result.continue;
    }
  };
  const call = async (params: GoalParams) => tools.get('goal').execute('test', params, undefined, undefined, ctx);
  const enable = async () => {
    ctx.isIdle = () => false;
    await call({ action: 'create', title: 'late abort', maxTurns: 3 });
    await fire('input', { source: 'rpc', text: 'enable' });
    await call({ action: 'enable', id: 1 });
    ctx.isIdle = () => true;
  };
  const message = (stopReason: string, errorMessage = 'provider disconnected') => entries.push({
    type: 'message', id: `failure-${++sequence}`, message: { role: 'assistant', stopReason, errorMessage },
  });
  const retries = () => wakes.filter((wake) => wake.customType === GOAL_RETRY_MESSAGE);
  return { ctx, fire, call, enable, message, retries, wakes, entries, state: () => entries.findLast((entry) => entry.customType === GOAL_TYPE)?.data as GoalState };
}

{
const controls = fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url));
const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
const freshStart = (root?: string) => IsolatedClient.start(root, 'm3-regression', [controls], ['--dag-workflow-test-child-provider', offline]);
let shared: IsolatedClient | undefined;
after(async () => { await shared?.close(); });
async function start() {
  if (!shared) shared = await freshStart();
  else { await shared.send('new_session'); shared.records.length = 0; }
  return shared;
}
const goals = (entries: unknown[]) => (entries as { customType?: string; data?: GoalState }[]).findLast((entry) => entry.customType === GOAL_TYPE)?.data;
const continuations = (entries: unknown[]) => (entries as any[]).filter((entry) => entry.type === 'custom_message' && entry.customType === GOAL_CONTINUE_MESSAGE);
const widgets = (client: IsolatedClient) => client.records.filter((record) => record.method === 'setWidget').flatMap((record) => (record.widgetLines as string[] | undefined) ?? []).map(stripTerminalSequences).join('\n');
async function call(client: IsolatedClient, params: object) {
  const events = await client.prompt(`TEST CALL goal ${JSON.stringify(params)}`);
  const event = events.find((item) => item.type === 'tool_execution_end' && item.toolName === 'goal')!;
  assert.ok(event); const result = event.result as { isError?: boolean; details: any; content: { text: string }[] }; return { ...result, isError: event.isError === true || result.isError === true };
}

test('actual Pi: real focus header, shared budget reaches its cap and inspections cannot refill it', { timeout: 30000 }, async () => {
  const client = await start();
  assert.ok(!(await call(client, { action: 'create', title: '预算测试', maxTurns: 2 })).isError);
  await call(client, { action: 'enable', id: 1 });
  let entries = await client.entries(); let state = goals(entries)!;
  assert.equal(state.run.used, 2); assert.equal(state.run.paused, true); assert.match(state.run.reason!, /上限/);
  assert.equal(continuations(entries).length, 2);
  assert.match(widgets(client), /Goal: #1 预算测试/);
  await call(client, { action: 'get' }); await call(client, { action: 'list' });
  entries = await client.entries(); state = goals(entries)!;
  assert.equal(state.run.used, 2); assert.equal(continuations(entries).length, 2);
  assert.equal(state.run.paused, true);
  assert.ok(!(await call(client, { action: 'enable' })).isError);
  assert.equal(continuations(await client.entries()).length, 4);
});
test('actual Pi: regular research replans after eight repeated reports and completion remains explicit', { timeout: 30000 }, async () => {
  const client = await start();
  await call(client, { action: 'create', title: '研究测试' }); await call(client, { action: 'enable', id: 1 });
  const entries = await client.entries(); const state = goals(entries)!;
  assert.equal(state.run.paused, true); assert.match(state.run.reason!, /无新进展/);
  assert.equal(state.run.stalled, 9); assert.equal(continuations(entries).length, 10);
  assert.match(continuations(entries).at(-1).content, /execute a different feasible approach now/);
  assert.ok(!entries.some((entry: any) => entry.customType === STATE_TYPE), 'research does not require Todo creation');
  await call(client, { action: 'create', title: '完成测试' }); await call(client, { action: 'enable', id: 2 });
  const completed = goals(await client.entries())!;
  assert.equal(completed.goals[1]!.status, 'completed'); assert.equal(completed.focusId, undefined);
});
test('actual Pi: Plan command/tool restrictions agree; off/reload/status never restart a paused Goal', { timeout: 30000 }, async (t) => {
  let client = await freshStart(); t.after(() => client.close());
  await call(client, { action: 'create', title: '暂停测试' });
  await call(client, { action: 'enable', id: 1 }); // One initial action; no next checkpoint then pauses.
  const before = continuations(await client.entries()).length;
  await client.prompt('/plan start');
  assert.equal((await call(client, { action: 'create', title: '不允许' })).isError, true);
  const afterBlocked = goals(await client.entries())!;
  assert.equal(afterBlocked.goals.length, 1);
  const command = await client.prompt('/goal new 不允许');
  assert.ok(command.some((record) => record.method === 'notify' && String(record.message).includes('Plan')));
  assert.ok(!(await call(client, { action: 'list' })).isError);
  await client.prompt('/plan off'); await call(client, { action: 'get' });
  assert.equal(continuations(await client.entries()).length, before);
  await client.prompt('/test-reload');
  await call(client, { action: 'list' });
  assert.equal(goals(await client.entries())!.run.paused, true);
  await client.close(false); client = await freshStart(client.root);
  assert.ok(!client.records.some((record) => record.type === 'agent_start'));
  await call(client, { action: 'get' });
  assert.equal(continuations(await client.entries()).length, before);
});
test('actual Pi: waiting child does not poll; question wake uses the same Goal budget and late reports cannot bypass cap', { timeout: 30000 }, async () => {
  const client = await start();
  await call(client, { action: 'create', title: '委派测试', maxTurns: 2 }); await call(client, { action: 'enable', id: 1 });
  // Child startup plus a real RPC round trip can exceed the default wait on a loaded CI runner.
  await client.until(() => client.records.some((record) => record.type === 'entry_appended' && (record.entry as any)?.customType === GOAL_TYPE && (record.entry as any)?.data?.run?.paused), 25000);
  // Report and child completion are asynchronous; wait for durable job state rather than sleep.
  await client.until(() => client.records.some((record) => record.type === 'entry_appended' && (record.entry as any)?.customType === AGENTS_TYPE && (record.entry as any)?.data?.jobs?.some((job: any) => job.status === 'completed')), 25000);
  // A completed child is not the cap: the parent still has to spend the second round and pause on it,
  // so wait for that record instead of reading the budget right after the job record.
  await client.until(() => {
    const latest = [...(client.records as any[])].reverse().find((record) => record.type === 'entry_appended' && record.entry?.customType === GOAL_TYPE)?.entry?.data;
    return latest?.run?.used === 2 && latest?.run?.paused === true;
  }, 25000);
  let entries = await client.entries(); const state = goals(entries)!;
  assert.equal(state.run.used, 2); assert.match(state.run.reason!, /上限/);
  assert.equal(continuations(entries).length, 1);
  const reports = (entries as any[]).filter((entry) => entry.customType === AGENT_REPORT_MESSAGE);
  assert.equal(reports.length, 1, 'question wakes once; result is saved only after cap');
  await call(client, { action: 'get' }); entries = await client.entries();
  assert.equal(goals(entries)!.run.used, 2);
});
test('actual Pi without a compaction plugin: explicit enable wakes an active idle Goal using its remaining budget', { timeout: 30000 }, async () => {
  const client = await start();
  await call(client, { action: 'create', title: '空闲续跑测试', maxTurns: 4 });
  await client.prompt('/goal enable #1');
  await client.until(() => client.records.filter((record) => record.type === 'agent_settled').length >= 2);
  const before = goals(await client.entries())!;
  assert.equal(before.run.paused, false, 'a running child leaves the parent idle and the goal active');
  assert.equal(before.run.used, 1);
  const offset = client.records.length;
  await client.prompt('/goal enable #1');
  await client.until(() => client.records.slice(offset).some((record) => record.type === 'tool_execution_end' && record.toolName === 'goal'));
  const after = goals(await client.entries())!;
  assert.equal(after.goals[0]!.status, 'completed', 'the direct command actually starts another model request');
  assert.equal(after.run.used, 2, 'same-goal enable retains the spent round rather than resetting the budget');
  assert.equal(client.records.filter((record) => record.type === 'tool_execution_end' && record.toolName === 'subagent_spawn').length, 1, 'resuming cannot redispatch the original child');
});

test('actual Pi: abort locks automatic work until explicit resume; zero phantom retry after status', { timeout: 30000 }, async () => {
  const client = await start();
  await call(client, { action: 'create', title: '中断测试' });
  const offset = client.records.length;
  await client.send('prompt', { message: '/goal enable 1' });
  await client.until(() => client.records.slice(offset).some((record) => record.type === 'message_start' && (record.message as any)?.role === 'assistant'));
  await client.send('abort');
  await call(client, { action: 'get' });
  const state = goals(await client.entries())!;
  assert.equal(state.run.paused, true); assert.match(state.run.reason!, /中断/);
  assert.equal(state.run.used, 1);
});
}

{
const legacyReason = '模型中止（旧宿主无法确认取消）';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('public event simulation: an error pause stays final across a later stop and native willRetry', async (t) => {
  const h = await goalHost(); t.after(() => h.fire('session_shutdown'));
  await h.enable(); h.message('error');
  await h.fire('agent_settled', { aborted: false }); // /retry is off, so the failure pauses the Goal.
  h.ctx.signal = AbortSignal.abort();
  await h.fire('agent_settled', { aborted: true }); // The explicit signal, not the provider flag, proves cancellation.
  assert.equal(h.state().run.paused, true);
  assert.equal(h.state().run.reason, '用户中断');
  await sleep(150);
  assert.equal(h.retries().length, 0);
  assert.equal(h.wakes.length, 0, 'neither old retry nor idle continuation may revive the Goal');
  await h.fire('agent_settled', { aborted: false });
  await h.fire('session_before_compact', { willRetry: true });
  h.entries.push({ type: 'compaction', id: 'later-native-boundary' });
  await h.fire('session_compact', { willRetry: true });
  await sleep(100);
  assert.equal(h.state().run.paused, true, 'native willRetry cannot rearm a final user stop');
  assert.equal(h.wakes.length, 0);
});

test('public event simulation: authoritative stop refunds rejected wake before any fallback', async (t) => {
  const h = await goalHost(); t.after(() => h.fire('session_shutdown'));
  await h.enable();
  await h.fire('agent_before_settle', { outcome: 'completed', continue: false, entries: [] });
  assert.equal(h.state().run.used, 1);
  await h.fire('agent_settled', { aborted: true });
  assert.equal(h.state().run.pendingWake, undefined);
  assert.equal(h.state().run.used, 0);
  await sleep(100);
  assert.equal(h.wakes.length, 0);
});

for (const modern of [true, false]) test(`public event simulation: provider abort with /retry off becomes a ${modern ? 'clear error' : 'legacy fail-closed'} pause`, async (t) => {
  const h = await goalHost(); t.after(() => h.fire('session_shutdown'));
  await h.enable(); h.message('aborted', modern ? 'provider disconnected' : '');
  await h.fire('agent_before_settle', { outcome: 'aborted' });
  assert.equal(h.state().run.paused, false, 'native recovery gets the first opportunity');
  await h.fire('agent_settled', modern ? { aborted: false } : {});
  await sleep(150);
  assert.equal(h.retries().length, 0, 'the Goal no longer answers failures itself');
  assert.equal(h.state().run.paused, !modern);
  if (!modern) assert.equal(h.state().run.reason, legacyReason);
  assert.equal(h.state().run.errorRetries ?? 0, 0);
});

test('public event simulation: legacy pauses only unresolved aborted failures after native recovery', async (t) => {
  const h = await goalHost(); t.after(() => h.fire('session_shutdown'));
  await h.enable(); h.message('aborted');
  await h.fire('agent_before_settle', { outcome: 'aborted' });
  h.message('stop'); // Native recovery succeeded before final settlement.
  await h.fire('agent_settled');
  await sleep(100);
  assert.equal(h.state().run.paused, false);
  assert.equal(h.retries().length, 0);
  assert.ok(h.wakes.some((wake) => wake.customType === GOAL_CONTINUE_MESSAGE));
});

const states = (client: IsolatedClient) => client.records
  .filter((record) => record.type === 'entry_appended' && (record.entry as { customType?: string })?.customType === GOAL_TYPE)
  .map((record) => (record.entry as { data: GoalState }).data);
const latest = (client: IsolatedClient) => states(client).at(-1)!;
const observations = (client: IsolatedClient) => client.records
  .filter((record) => record.type === 'entry_appended' && (record.entry as { customType?: string })?.customType === 'dag-test.late-settle')
  .map((record) => (record.entry as { data: { stage: string; outcome: string; idle: boolean; publicSignalAborted: boolean | null; capturedSignalAborted: boolean | null } }).data);
const reportsCancellation = (client: IsolatedClient) => client.records.some((record) => record.type === 'agent_settled' && typeof record.aborted === 'boolean');
const retryEntries = async (client: IsolatedClient) => (await client.entries()).filter((entry) => (entry as { customType?: string }).customType === RETRY_REQUEST_MESSAGE);
async function startIsolated() {
  const root = await mkdtemp(join(tmpdir(), 'pi-dag-late-abort-'));
  await mkdir(join(root, 'agent'), { recursive: true });
  await writeFile(join(root, 'agent', 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
  const observer = fileURLToPath(new URL('./fixtures/goal-late-settle.ts', import.meta.url));
  return IsolatedClient.start(root, 'goal-late-abort', [observer], ['--dag-test-late-settle']);
}
async function createProviderAbortGoal(client: IsolatedClient, emptyError = false) {
  await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'create', title: 'provider断流测试' + (emptyError ? ' empty-error' : ''), maxTurns: 3 })}`);
  await client.prompt('/goal enable #1');
  await client.until(() => observations(client).some((item) => item.stage === 'waiting'));
}
function assertPublicSignalGap(client: IsolatedClient) {
  const observed = observations(client);
  assert.deepEqual(observed.map((item) => item.stage), ['waiting', 'finished']);
  assert.ok(observed.every((item) => item.outcome === 'aborted' && item.publicSignalAborted === null && item.capturedSignalAborted === false), JSON.stringify(observed));
  assert.equal(observed[0]!.idle, false, 'session remains busy even though no public operation signal exists');
}

for (const cancel of [true, false]) test(`actual offline Pi: async provider-aborted settlement ${cancel ? 'obeys late clear_queue + abort' : 'recovers only with reliable no-cancel evidence'}`, { timeout: 15000 }, async (t) => {
  const client = await startIsolated(); t.after(() => client.close());
  await createProviderAbortGoal(client, cancel);
  const modern = reportsCancellation(client);
  // Arm /retry during the late-settle gap: only a reliable no-cancel settlement may recover.
  await client.prompt('/retry when-error 1s count 2');
  const stop = client.records.length;
  if (cancel) {
    await client.send('clear_queue');
    await client.send('abort');
  }
  await client.until(() => observations(client).some((item) => item.stage === 'finished'));
  if (!cancel && modern) await client.until(() => latest(client).goals[0]?.status === 'completed');
  else await client.until(() => latest(client).run.paused);
  assertPublicSignalGap(client);
  if (cancel || !modern) {
    assert.equal(latest(client).run.reason, modern ? '用户中断' : legacyReason);
    assert.equal(latest(client).run.errorRetries ?? 0, 0);
    assert.equal(latest(client).goals[0]?.status, 'active');
    await sleep(1400); // Covers the first Goal recovery backoff and idle-resume timers.
    assert.equal((await retryEntries(client)).length, 0);
    assert.equal(client.records.slice(stop).filter((record) => record.type === 'turn_start').length, 0);
    await client.prompt('/goal get #1');
    assert.equal(latest(client).run.paused, true, 'read-only input cannot rearm the stopped Goal');
    await client.prompt('/goal enable #1');
    await client.until(() => latest(client).goals[0]?.status === 'completed');
    assert.equal((await retryEntries(client)).length, 0, 'explicit enable starts fresh work, not an old retry timer');
  } else {
    assert.equal((await retryEntries(client)).length, 1);
    assert.equal(states(client).some((state) => state.run.reason === '用户中断'), false);
    assert.equal(states(client).some((state) => state.run.reason === legacyReason), false);
  }
  if (modern) {
    const settled = client.records.filter((record) => record.type === 'agent_settled');
    assert.equal(settled.some((record) => record.aborted === true), cancel);
  } else {
    assert.equal(client.records.filter((record) => record.type === 'agent_settled').every((record) => record.aborted === undefined), true);
  }
  assert.equal(client.records.some((record) => record.type === 'extension_error'), false);
});
}

{
async function agentRoot(config?: object, retry: object = { enabled: false }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-dag-retry-'));
  const agent = join(root, 'agent');
  await mkdir(join(agent, 'pi-dag-workflow'), { recursive: true });
  // Native retry stays off unless a case explicitly exercises Pi's own recovery layer.
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ retry }));
  if (config) await writeFile(join(agent, 'pi-dag-workflow', 'pi-dag-workflow-config.json'), JSON.stringify(config));
  return root;
}
const states = (client: IsolatedClient) => client.records
  .filter((record) => record.type === 'entry_appended' && (record.entry as { customType?: string } | undefined)?.customType === GOAL_TYPE)
  .map((record) => (record.entry as { data: GoalState }).data);
const latest = (client: IsolatedClient) => states(client).at(-1);
const retryRequests = async (client: IsolatedClient) => (await client.entries()).filter((entry) => (entry as { customType?: string }).customType === RETRY_REQUEST_MESSAGE);
const retryStates = (client: IsolatedClient) => client.records
  .filter((record) => record.type === 'entry_appended' && (record.entry as { customType?: string } | undefined)?.customType === 'pi-dag-workflow.retry')
  .map((record) => (record.entry as { data: { enabled: boolean; attempts: number; skipped: number; settings?: { count?: number } } }).data);
const retryState = (client: IsolatedClient) => retryStates(client).at(-1);
async function create(client: IsolatedClient, title: string) {
  const events = await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'create', title })}`);
  assert.ok(events.some((event) => event.type === 'tool_execution_end' && event.toolName === 'goal' && !event.isError), JSON.stringify(events.slice(-3)));
  const events2 = await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'enable', id: 1 })}`);
  assert.ok(events2.some((event) => event.type === 'tool_execution_end' && event.toolName === 'goal' && !event.isError), JSON.stringify(events2.slice(-3)));
}

for (const [title, marker] of [['永久故障测试', 'quota'], ['认证故障测试', 'auth']] as const) test(`actual Pi: a ${marker} error is retried up to count, then the Goal pauses`, { timeout: 45000 }, async (t) => {
  const client = await IsolatedClient.start(await agentRoot(), `goal-${marker}-retry`); t.after(() => client.close());
  await client.prompt('/retry when-error 1s count 2');
  await create(client, title);
  await client.until(() => retryState(client)?.attempts === 2 && latest(client)?.run.paused === true, 35000);
  assert.match(latest(client)!.run.reason!, /\/retry/);
  assert.equal((await retryRequests(client)).length, 2, 'every configured attempt is a real retry request');
  assert.equal(retryState(client)?.attempts, 2);
  assert.equal(retryState(client)?.settings?.count, 2);
});
}

{
async function agentRoot(config?: object, retry: object = { enabled: false }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-dag-retry-'));
  const agent = join(root, 'agent');
  await mkdir(join(agent, 'pi-dag-workflow'), { recursive: true });
  // Native retry stays off unless a case explicitly exercises Pi's own recovery layer.
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ retry }));
  if (config) await writeFile(join(agent, 'pi-dag-workflow', 'pi-dag-workflow-config.json'), JSON.stringify(config));
  return root;
}
const states = (client: IsolatedClient) => client.records
  .filter((record) => record.type === 'entry_appended' && (record.entry as { customType?: string } | undefined)?.customType === GOAL_TYPE)
  .map((record) => (record.entry as { data: GoalState }).data);
const latest = (client: IsolatedClient) => states(client).at(-1);
const retryRequests = async (client: IsolatedClient) => (await client.entries()).filter((entry) => (entry as { customType?: string }).customType === RETRY_REQUEST_MESSAGE);
async function create(client: IsolatedClient, title: string) {
  const events = await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'create', title })}`);
  assert.ok(events.some((event) => event.type === 'tool_execution_end' && event.toolName === 'goal' && !event.isError), JSON.stringify(events.slice(-3)));
  const events2 = await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'enable', id: 1 })}`);
  assert.ok(events2.some((event) => event.type === 'tool_execution_end' && event.toolName === 'goal' && !event.isError), JSON.stringify(events2.slice(-3)));
}

test('actual Pi: reopened /retry cannot restart a Goal completed after its failed request', { timeout: 30000 }, async (t) => {
  const root = await agentRoot(); let client = await IsolatedClient.start(root, 'goal-retry-completed-reopen'); t.after(() => client.close());
  await create(client, '出错暂停测试'); await client.until(() => latest(client)?.run.errorRetries === 1);
  await client.prompt('/goal complete #1'); await client.close(false);
  client = await IsolatedClient.start(root, 'goal-retry-completed-reopen');
  await client.prompt('/retry when-error 1s count 1'); await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal((await retryRequests(client)).length, 0);
});
}

{
async function agentRoot(config?: object, retry: object = { enabled: false }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-dag-retry-'));
  const agent = join(root, 'agent');
  await mkdir(join(agent, 'pi-dag-workflow'), { recursive: true });
  // Native retry stays off unless a case explicitly exercises Pi's own recovery layer.
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ retry }));
  if (config) await writeFile(join(agent, 'pi-dag-workflow', 'pi-dag-workflow-config.json'), JSON.stringify(config));
  return root;
}
const states = (client: IsolatedClient) => client.records
  .filter((record) => record.type === 'entry_appended' && (record.entry as { customType?: string } | undefined)?.customType === GOAL_TYPE)
  .map((record) => (record.entry as { data: GoalState }).data);
const latest = (client: IsolatedClient) => states(client).at(-1);
const retryRequests = async (client: IsolatedClient) => (await client.entries()).filter((entry) => (entry as { customType?: string }).customType === RETRY_REQUEST_MESSAGE);
async function create(client: IsolatedClient, title: string) {
  const events = await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'create', title })}`);
  assert.ok(events.some((event) => event.type === 'tool_execution_end' && event.toolName === 'goal' && !event.isError), JSON.stringify(events.slice(-3)));
  const events2 = await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'enable', id: 1 })}`);
  assert.ok(events2.some((event) => event.type === 'tool_execution_end' && event.toolName === 'goal' && !event.isError), JSON.stringify(events2.slice(-3)));
}

test('actual Pi: bounded /retry runs only after native retries are exhausted', { timeout: 60000 }, async (t) => {
  const root = await agentRoot(undefined, { enabled: true, maxRetries: 1, baseDelayMs: 1 });
  const client = await IsolatedClient.start(root, 'goal-native-exhausted');
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  await client.prompt('/retry when-error 1s count 2');
  await create(client, '出错暂停测试');
  await client.until(() => client.records.filter((record) => record.type === 'auto_retry_start').length === 3 && latest(client)?.run.paused === true, 45000);
  // Each plugin retry is itself eligible for one native retry before the next plugin wait.
  assert.equal(client.records.filter((record) => record.type === 'auto_retry_start').length, 3);
  assert.equal((await retryRequests(client)).length, 2);
  assert.match(latest(client)!.run.reason!, /\/retry/);
});
}

{
async function agentRoot(config?: object, retry: object = { enabled: false }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-dag-retry-'));
  const agent = join(root, 'agent');
  await mkdir(join(agent, 'pi-dag-workflow'), { recursive: true });
  // Native retry stays off unless a case explicitly exercises Pi's own recovery layer.
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ retry }));
  if (config) await writeFile(join(agent, 'pi-dag-workflow', 'pi-dag-workflow-config.json'), JSON.stringify(config));
  return root;
}
const states = (client: IsolatedClient) => client.records
  .filter((record) => record.type === 'entry_appended' && (record.entry as { customType?: string } | undefined)?.customType === GOAL_TYPE)
  .map((record) => (record.entry as { data: GoalState }).data);
const latest = (client: IsolatedClient) => states(client).at(-1);
const retryRequests = async (client: IsolatedClient) => (await client.entries()).filter((entry) => (entry as { customType?: string }).customType === RETRY_REQUEST_MESSAGE);
const retryStates = (client: IsolatedClient) => client.records
  .filter((record) => record.type === 'entry_appended' && (record.entry as { customType?: string } | undefined)?.customType === 'pi-dag-workflow.retry')
  .map((record) => (record.entry as { data: { enabled: boolean; attempts: number; skipped: number; settings?: { count?: number } } }).data);
const retryState = (client: IsolatedClient) => retryStates(client).at(-1);
async function create(client: IsolatedClient, title: string) {
  const events = await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'create', title })}`);
  assert.ok(events.some((event) => event.type === 'tool_execution_end' && event.toolName === 'goal' && !event.isError), JSON.stringify(events.slice(-3)));
  const events2 = await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'enable', id: 1 })}`);
  assert.ok(events2.some((event) => event.type === 'tool_execution_end' && event.toolName === 'goal' && !event.isError), JSON.stringify(events2.slice(-3)));
}

test('actual Pi: turning /retry off during a failed Goal leaves it paused without a hidden retry', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(await agentRoot(), 'goal-retry-off-during-wait'); t.after(() => client.close());
  await client.prompt('/retry when-error 1s count 3'); await create(client, '出错暂停测试');
  await client.prompt('/retry off'); await client.until(() => latest(client)?.run.paused === true);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal((await retryRequests(client)).length, 0);
  assert.equal(latest(client)!.run.paused, true); assert.equal(retryState(client)?.enabled, false);
});
}

{
for (const language of ['zh-CN', 'en']) {
  test(`real Pi: finished Todos and a plain final answer do not end an active Goal (${language})`, { timeout: 30000 }, async (t) => {
    const client = await IsolatedClient.start(undefined, 'goal-objective', [], ['--dag-test-plain-goal'], false, undefined, language);
    t.after(() => client.close());
    await client.prompt('TEST CALL todo {"action":"create","subject":"finish the first phase"}');
    await client.prompt('TEST CALL goal {"action":"create","title":"Complete the full objective","description":"The first Todo is only a phase; write objective evidence before completion.","maxTurns":6}');
    await client.prompt('/goal enable #1');
    await client.until(() => client.records.some((event) => event.type === 'entry_appended' && (event.entry as any)?.customType === GOAL_TYPE && (event.entry as any).data.goals[0].status === 'completed'));
    const entries = await client.entries() as any[];
    const final = entries.findLast((entry) => entry.type === 'custom' && entry.customType === GOAL_TYPE).data as GoalState;
    assert.equal(final.goals[0]!.status, 'completed');
    assert.equal(final.run.used, 2);
    assert.equal(final.run.reason, language === 'en' ? 'Goal completed' : '目标已完成');
    assert.equal(await readFile(join(client.root, 'objective-evidence.txt'), 'utf8'), 'GOAL-CONTINUED\n');
    const continued = entries.findIndex((entry) => entry.customType === GOAL_CONTINUE_MESSAGE);
    assert.ok(continued > 0, 'an automatic decision follows the first model final answer');
    assert.match(entries[continued].content, /goal get/);
    const earlierTodo = entries.slice(0, continued).findLast((entry) => entry.type === 'custom' && entry.customType === STATE_TYPE).data;
    assert.ok(earlierTodo.tasks.every((task: any) => task.status === 'completed'), 'all Todos were already complete before the objective continuation');
    const earlierGoal = entries.slice(0, continued).filter((entry) => entry.type === 'custom' && entry.customType === GOAL_TYPE).map((entry) => entry.data as GoalState);
    assert.ok(earlierGoal.some((state) => state.run.used === 1 && !state.run.paused && state.run.nextStep === undefined));
    assert.ok(!earlierGoal.some((state) => state.run.reason === '没有具体下一步，等待用户' || state.run.reason === 'No concrete next step; waiting for the user'));
    assert.ok(entries.slice(0, continued).some((entry) => entry.type === 'message' && entry.message?.role === 'assistant' && entry.message.stopReason === 'stop'), 'the first round actually stopped; native tool follow-ups alone cannot explain phase two');
  });
}
}

{
test('tool guidance distinguishes milestones from per-turn reporting without adding a semantic classifier', async () => {
  let tool: any;
  await loadPublic({ on() {}, registerCommand() {}, registerTool(value: any) { tool = value; } } as any, ['goal']);
  assert.match(tool.description, /verified milestone, reproducible finding, key decision, changed blocker/);
  assert.match(tool.description, /skip routine activity, repeated notes and Todo status/);
  assert.ok(tool.promptGuidelines.some((rule: string) => rule.includes('not every turn, tool call, wait or Todo update')));
  assert.ok(tool.promptGuidelines.some((rule: string) => rule.includes('same tool batch')));
});

test('actual offline Pi: repeated important notes do not write canonical state or reset progress', { timeout: 20000 }, async (t) => {
  const offline = new URL('./fixtures/offline-model.ts', import.meta.url).pathname;
  const client = await IsolatedClient.start(undefined, 'important-goal-notes', [], ['--dag-workflow-test-child-provider', offline]); t.after(() => client.close());
  await client.prompt('TEST CALL subagent_spawn {"task":"HOLD-IDLE-ENABLE-CHILD"}');
  await client.prompt('TEST CALL goal {"action":"create","title":"verify real results","maxTurns":8}');
  await client.prompt('/goal enable #1');
  await client.prompt('TEST CALL goal {"action":"update","progress":"12 checks pass"}');
  const snapshots = async () => (await client.entries() as any[]).filter((entry) => entry.customType === 'pi-dag-workflow.goal');
  const before = await snapshots();
  await client.prompt('TEST CALL goal {"action":"update","progress":" 12 checks pass "}');
  const after = await snapshots();
  assert.equal(after.length, before.length);
  assert.deepEqual(after.at(-1).data.run, before.at(-1).data.run);
  await client.prompt('/goal disable #1');
});
}

{
test('initial Goal attention step is consumed while waiting; later child messages do not restart a polling loop', async (t) => {
  const { protocolHost } = await import('./fixtures/agents-protocol-host.ts');
  const h = await protocolHost({ features: ['todos', 'agents', 'goal'], idle: false }); t.after(() => h.close());
  const child = await h.call('subagent_spawn', { task: 'CONTROL REPORT HOLD', tools: ['read', 'bash'] });
  const waiting = await h.call('subagent_inspect', { jobId: child.jobId, output: true, until: 'update', timeout: 5 });
  assert.equal(waiting.status, 'running');
  await h.call('goal', { action: 'create', title: '等待真实结果' });
  await h.emit('input', { source: 'rpc', text: '启用' });
  await h.call('goal', { action: 'enable', id: 1 });
  const state = () => h.entries.findLast(entry => entry.customType === GOAL_TYPE).data as GoalState;
  const settle = () => h.emit('agent_before_settle', { outcome: 'completed', continue: false, entries: [] });
  assert.equal((await settle())?.continue, undefined, 'passive checkpoints cannot start a polling loop');
  assert.equal(state().run.nextStep, undefined);
  h.options.idle = true;
  await h.call('subagent_send', { recipient: child.jobId, interrupt: true, message: 'Complete the read-only report' });
  const deadline = Date.now() + 5000;
  while (!h.sent.some(item => item.message.customType === AGENT_REPORT_MESSAGE)) { if (Date.now() > deadline) throw new Error('child-result wake did not arrive'); await delay(10); }
  assert.equal(state().run.used, 1, 'the actual child-result wake reserves one round');
  h.options.idle = false;
  assert.equal((await settle())?.continue, undefined);
  assert.equal(state().run.used, 1);
  assert.equal(state().run.paused, false);
});
}
