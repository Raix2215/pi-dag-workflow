import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerGoal } from '../src/goal/register.ts';
import { GOAL_TYPE, type GoalParams, type GoalState } from '../src/goal/state.ts';
import { emptyState } from '../src/todos/state.ts';
import { IsolatedClient } from './fixtures/isolated-client.ts';

const legacyReason = '模型中止（旧宿主无法确认取消）';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Simulated public extension events, separate from the actual offline Pi cases below. */
function goalHost() {
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const entries: any[] = []; const wakes: any[] = [];
  const workflow = emptyState();
  let sequence = 0;
  const ctx: any = {
    cwd: tmpdir(), mode: 'rpc', hasUI: false, signal: undefined, isIdle: () => true,
    sessionManager: { getBranch: () => entries, getLeafId: () => String(entries.length) },
    ui: { notify() {} },
  };
  const pi: any = {
    on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {},
    appendEntry(customType: string, data: any) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); },
    sendMessage(message: any, options: any) { if (options?.triggerTurn) wakes.push(message); },
    sendUserMessage(message: string) { wakes.push(message); },
  };
  const controller = registerGoal(pi, {
    state: () => workflow, jobs: () => [], paint() {}, protected: () => false,
    pauseAgents() {}, resumeAgents() {}, retryDelayMs: 70, resumeDelayMs: 0,
  });
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
  const message = (stopReason: string) => entries.push({
    type: 'message', id: `failure-${++sequence}`, message: { role: 'assistant', stopReason, errorMessage: 'provider disconnected' },
  });
  const retries = () => wakes.filter((wake) => wake.customType === 'pi-dag-workflow.goal-retry');
  return { ctx, controller, fire, call, enable, message, retries, wakes, entries };
}

test('public event simulation: authoritative late cancellation cancels retry and resume timers', async (t) => {
  const h = goalHost(); t.after(() => h.fire('session_shutdown'));
  await h.enable(); h.message('error');
  await h.fire('agent_settled', { aborted: false }); // A previous failed request has pending recovery.
  await h.fire('agent_settled', { aborted: true }); // Stop is authoritative, independent of stopReason.
  assert.equal(h.controller.snapshot().run.paused, true);
  assert.equal(h.controller.snapshot().run.reason, '用户中断');
  await sleep(150);
  assert.equal(h.retries().length, 0);
  assert.equal(h.wakes.length, 0, 'neither old retry nor idle continuation may revive the Goal');
  await h.fire('agent_settled', { aborted: false });
  await h.fire('session_before_compact', { willRetry: true });
  h.entries.push({ type: 'compaction', id: 'later-native-boundary' });
  await h.fire('session_compact', { willRetry: true });
  await sleep(100);
  assert.equal(h.controller.snapshot().run.paused, true, 'native willRetry cannot rearm a final user stop');
  assert.equal(h.wakes.length, 0);
});

test('public event simulation: authoritative stop refunds rejected wake before any fallback', async (t) => {
  const h = goalHost(); t.after(() => h.fire('session_shutdown'));
  await h.enable();
  assert.equal(h.controller.reserveWake(h.ctx, true), true);
  assert.equal(h.controller.snapshot().run.used, 1);
  await h.fire('agent_settled', { aborted: true });
  assert.equal(h.controller.snapshot().run.pendingWake, undefined);
  assert.equal(h.controller.snapshot().run.used, 0);
  await sleep(100);
  assert.equal(h.wakes.length, 0);
});

for (const modern of [true, false]) test(`public event simulation: provider abort settles with ${modern ? 'explicit no-cancel recovery' : 'legacy fail-closed pause'}`, async (t) => {
  const h = goalHost(); t.after(() => h.fire('session_shutdown'));
  await h.enable(); h.message('aborted');
  await h.fire('agent_before_settle', { outcome: 'aborted' });
  assert.equal(h.controller.snapshot().run.paused, false, 'native recovery gets the first opportunity');
  await h.fire('agent_settled', modern ? { aborted: false } : {});
  await sleep(150);
  assert.equal(h.retries().length, modern ? 1 : 0);
  assert.equal(h.controller.snapshot().run.paused, !modern);
  assert.equal(h.controller.snapshot().run.reason, modern ? undefined : legacyReason);
  assert.equal(h.controller.snapshot().run.errorRetries ?? 0, modern ? 1 : 0);
});

test('public event simulation: legacy pauses only unresolved aborted failures after native recovery', async (t) => {
  const h = goalHost(); t.after(() => h.fire('session_shutdown'));
  await h.enable(); h.message('aborted');
  await h.fire('agent_before_settle', { outcome: 'aborted' });
  h.message('stop'); // Native recovery succeeded before final settlement.
  await h.fire('agent_settled');
  await sleep(100);
  assert.equal(h.controller.snapshot().run.paused, false);
  assert.equal(h.retries().length, 0);
  assert.ok(h.wakes.some((wake) => wake.customType === 'pi-dag-workflow.goal-continue'));
});

const states = (client: IsolatedClient) => client.records
  .filter((record) => record.type === 'entry_appended' && (record.entry as { customType?: string })?.customType === GOAL_TYPE)
  .map((record) => (record.entry as { data: GoalState }).data);
const latest = (client: IsolatedClient) => states(client).at(-1)!;
const observations = (client: IsolatedClient) => client.records
  .filter((record) => record.type === 'entry_appended' && (record.entry as { customType?: string })?.customType === 'dag-test.late-settle')
  .map((record) => (record.entry as { data: { stage: string; outcome: string; idle: boolean; publicSignalAborted: boolean | null; capturedSignalAborted: boolean | null } }).data);
const reportsCancellation = (client: IsolatedClient) => client.records.some((record) => record.type === 'agent_settled' && typeof record.aborted === 'boolean');
const retryEntries = async (client: IsolatedClient) => (await client.entries()).filter((entry) => (entry as { customType?: string }).customType === 'pi-dag-workflow.goal-retry');
async function startIsolated() {
  const root = await mkdtemp(join(tmpdir(), 'pi-dag-late-abort-'));
  await mkdir(join(root, 'agent'), { recursive: true });
  await writeFile(join(root, 'agent', 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
  const observer = fileURLToPath(new URL('./fixtures/goal-late-settle.ts', import.meta.url));
  return IsolatedClient.start(root, 'goal-late-abort', [observer], ['--dag-test-late-settle']);
}
async function createProviderAbortGoal(client: IsolatedClient) {
  await client.prompt('TEST CALL goal {"action":"create","title":"provider断流测试","maxTurns":3}');
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
  await createProviderAbortGoal(client);
  const modern = reportsCancellation(client);
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
