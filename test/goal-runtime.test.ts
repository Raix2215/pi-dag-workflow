import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerGoal } from '../src/goal/register.ts';
import { emptyState } from '../src/todos/state.ts';
import { GOAL_TYPE, type GoalParams } from '../src/goal/state.ts';

function host() {
  const events = new Map<string, Function[]>();
  const tools = new Map<string, any>(); const commands = new Map<string, any>();
  let workflow = emptyState(); let jobs: any[] = []; let protectedState = false; let idle = false;
  const entries: any[] = []; const notifications: string[] = []; const wakes: any[] = [];
  let messageSeq = 0;
  const ctx: any = { cwd: '/tmp', mode: 'rpc', hasUI: true, isIdle: () => idle, sessionManager: { getBranch: () => entries }, ui: { notify: (text: string) => notifications.push(text), confirm: async () => true } };
  const pi: any = { on(name: string, handler: Function) { events.set(name, [...events.get(name) ?? [], handler]); return () => {}; }, registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand(name: string, cmd: any) { commands.set(name, cmd); }, appendEntry(customType: string, data: any) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); }, sendMessage(message: any, options: any) { wakes.push({ message, options }); }, sendUserMessage(message: string) { wakes.push({ message, options: { source: 'extension' } }); } };
  const controller = registerGoal(pi, { state: () => workflow, jobs: () => jobs, paint() {}, protected: () => protectedState, pauseAgents() {}, resumeAgents() {}, retryDelayMs: 0 });
  const fire = async (name: string, event: any = {}) => { let result: any; for (const handler of events.get(name) ?? []) result = await handler(event, ctx) ?? result; return result; };
  const call = async (params: GoalParams) => tools.get('goal').execute('test', params, undefined, undefined, ctx);
  const settle = (event: any = {}) => fire('agent_before_settle', { outcome: 'completed', continue: false, ...event });
  const enable = async (maxTurns = 20) => { await call({ action: 'create', title: '研究', maxTurns }); await fire('input', { source: 'rpc', text: '启用目标' }); assert.ok(!(await call({ action: 'enable', id: 1 })).isError); };
  const message = (stopReason: string) => { entries.push({ type: 'message', id: `m${++messageSeq}`, parentId: null, message: { role: 'assistant', stopReason, errorMessage: stopReason === 'error' ? 'stream error' : undefined } }); };
  // A settled run schedules its retry on a timer; drain it before asserting.
  const settled = async () => { await fire('agent_settled'); await new Promise((resolve) => setTimeout(resolve, 0)); };
  const retries = () => wakes.filter((wake) => wake.message?.customType === 'pi-dag-workflow.goal-retry').length;
  return { ctx, controller, fire, call, settle, enable, settled, message, retries, entries, notifications, wakes, setPlan(value: boolean) { workflow = { ...workflow, plan: value }; }, setJobs(value: any[]) { jobs = value; }, setIdle(value: boolean) { idle = value; }, setProtected(value: boolean) { protectedState = value; }, commands };
}

test('mock host: shared Agent/Goal wakes consume one allowance, never reset on status/input/read', async () => {
  const h = host(); await h.enable(2);
  assert.equal(h.controller.reserveWake(h.ctx), true); // child-result wake
  assert.equal(h.controller.reserveWake(h.ctx), true); // Goal wake
  assert.equal(h.controller.reserveWake(h.ctx), false);
  await h.fire('input', { source: 'rpc', text: '查看状态' }); await h.call({ action: 'list' });
  assert.equal(h.controller.snapshot().run.used, 2);
  assert.equal(await h.settle(), undefined);
  assert.match(h.controller.snapshot().run.reason!, /上限/);
  const state = h.controller.snapshot();
  await h.call({ action: 'enable', id: 1 }); // User explicitly enables after the input, so this is a resume.
  assert.equal(state.run.used, 2);
});
test('mock host: a model error retries automatically and keeps the goal active', async () => {
  const h = host(); await h.enable(); h.setIdle(true);
  assert.equal(h.controller.snapshot().run.errorRetries, undefined);
  // One failure reports at turn_end, agent_end and agent_before_settle: it must retry once, and only
  // after the run settled, so Pi can finish its own recovery attempt first.
  h.message('error');
  await h.fire('turn_end', { outcome: 'error' });
  await h.fire('agent_before_settle', { outcome: 'error', continue: false });
  assert.equal(h.retries(), 0, 'an unsettled run has not failed out yet');
  await h.settled();
  const state = h.controller.snapshot();
  assert.equal(state.run.paused, false, 'a recoverable error must not pause the goal');
  assert.equal(state.run.errorRetries, 1);
  assert.equal(h.retries(), 1, 'the same failure must not queue two retries');
  assert.equal(h.notifications.filter((line) => line.includes('自动重试')).length, 1);
});

test('mock host: each failure earns its own retry while the budget lasts', async () => {
  const h = host(); await h.enable(); h.setIdle(true);
  // Two failures inside one run stay one retry: the newest failed request names the failure.
  h.message('error'); h.message('error');
  await h.settled();
  assert.equal(h.retries(), 1);
  assert.equal(h.controller.snapshot().run.errorRetries, 1);
  // The retry turn failing again is a new failure, so the next retry follows.
  h.message('error');
  await h.settled();
  assert.equal(h.retries(), 2, 'a later failure is never swallowed by the previous retry');
  assert.equal(h.controller.snapshot().run.errorRetries, 2);
  // A settled run that ends on success never retries.
  h.message('stop');
  await h.settled();
  assert.equal(h.retries(), 2);
});

test('mock host: retries stop at the configured limit and a successful turn clears the counter', async () => {
  const h = host(); await h.enable(); h.setIdle(true);
  for (let attempt = 1; attempt <= 5; attempt++) {
    h.message('error');
    await h.settled();
    assert.equal(h.controller.snapshot().run.paused, false, `attempt ${attempt} stays active`);
    assert.equal(h.controller.snapshot().run.errorRetries, attempt);
  }
  h.message('error');
  await h.settled();
  const exhausted = h.controller.snapshot();
  assert.equal(exhausted.run.paused, true, 'the sixth failure pauses');
  assert.match(exhausted.run.reason!, /已重试 5 次/);
  assert.equal(h.retries(), 5);

  // A completed turn resets the budget for the next failure.
  const fresh = host(); await fresh.enable(); fresh.setIdle(true);
  fresh.message('error');
  await fresh.settled();
  assert.equal(fresh.controller.snapshot().run.errorRetries, 1);
  await fresh.fire('turn_end', { outcome: 'completed' });
  assert.equal(fresh.controller.snapshot().run.errorRetries, 0);
  fresh.message('error');
  await fresh.settled();
  assert.equal(fresh.controller.snapshot().run.errorRetries, 1, 'a successful turn restores the full budget');
});

test('mock host: a user abort never retries', async () => {
  const h = host(); await h.enable(); h.setIdle(true);
  await h.fire('turn_end', { outcome: 'aborted' });
  assert.equal(h.controller.snapshot().run.paused, true);
  assert.match(h.controller.snapshot().run.reason!, /用户中断/);
  h.message('aborted');
  await h.fire('agent_end', { messages: [{ role: 'assistant', stopReason: 'aborted' }] });
  await h.settled();
  assert.equal(h.retries(), 0);
});

test('mock host: Plan, restore and abort pause persistently; only explicit enable can rearm', async () => {
  const h = host(); await h.enable();
  h.controller.pause('进入 Plan', h.ctx); h.setPlan(true);
  assert.equal((await h.call({ action: 'create', title: '不应创建' })).isError, true);
  assert.equal((await h.call({ action: 'list' })).isError, undefined);
  h.setPlan(false); await h.fire('input', { source: 'rpc', text: '查看信息' });
  assert.equal(await h.settle(), undefined);
  await h.fire('session_tree');
  assert.equal(h.controller.snapshot().run.paused, true);
  await h.fire('input', { source: 'rpc', text: '恢复目标' }); await h.call({ action: 'enable' });
  await h.settle({ outcome: 'aborted' });
  assert.equal(h.controller.snapshot().run.paused, true);
  assert.equal(h.controller.canWake(), false);
});
test('mock host: no Todos research checkpoints permit concrete actions; repeated reports stop at three', async () => {
  const h = host(); await h.enable();
  await h.call({ action: 'update', progress: '发现 API 边界', nextStep: '阅读 SDK 示例' });
  assert.equal((await h.settle()).continue, true);
  for (let i = 0; i < 3; i++) {
    await h.call({ action: 'update', progress: '发现 API 边界', nextStep: '阅读 SDK 示例' });
    const result = await h.settle();
    if (i < 2) assert.equal(result.continue, true); else assert.equal(result, undefined);
  }
  assert.match(h.controller.snapshot().run.reason!, /无新进展/);
  assert.equal(h.controller.snapshot().run.used, 3);
});
test('mock host: read-only calls/text do not count as progress; waiting children cause no polling', async () => {
  const h = host(); await h.enable();
  h.setJobs([{ id: 'a1', status: 'running' }]);
  assert.equal(await h.settle(), undefined);
  assert.equal(h.controller.snapshot().run.used, 0);
  assert.equal(h.controller.snapshot().run.paused, false);
  h.setJobs([]); await h.settle();
  await h.call({ action: 'update', nextStep: '' }); await h.settle();
  assert.match(h.controller.snapshot().run.reason!, /等待用户/);
});
test('mock host: failed tools and ordinary reads cannot masquerade as progress', async () => {
  const h = host(); await h.enable();
  await h.settle();
  await h.fire('tool_execution_end', { toolName: 'read', isError: false });
  await h.fire('tool_execution_end', { toolName: 'write', isError: true });
  await h.call({ action: 'update', nextStep: '下一步' }); await h.settle();
  assert.equal(h.controller.snapshot().run.stalled, 1);
  await h.fire('tool_execution_end', { toolName: 'edit', isError: false });
  await h.call({ action: 'update', nextStep: '下一步' }); await h.settle();
  assert.equal(h.controller.snapshot().run.stalled, 0);
});
test('mock host: native proposed continuation is not double charged; corrupt history stays protected', async () => {
  const h = host(); await h.enable();
  assert.equal(h.controller.reserveWake(h.ctx), true);
  assert.equal(await h.settle({ continue: true }), undefined);
  assert.equal(h.controller.snapshot().run.used, 1);
  h.entries.push({ type: 'custom', customType: GOAL_TYPE, data: { version: 99 } });
  await h.fire('session_tree');
  assert.equal((await h.call({ action: 'create', title: '不覆盖历史' })).isError, true);
  assert.equal(h.entries.at(-1).data.version, 99);
});
test('mock host: explicit idle enable reserves and starts once; unknown extra args cannot start work', async () => {
  const h = host(); await h.enable(); h.controller.pause('暂停', h.ctx); h.setIdle(true);
  await h.commands.get('goal').handler('enable extra arguments', h.ctx);
  assert.equal(h.wakes.length, 0);
  await h.commands.get('goal').handler('enable', h.ctx);
  assert.equal(h.wakes.length, 1);
  assert.equal(h.controller.snapshot().run.used, 1);
  assert.match(h.wakes[0].message, /Goal #1.*不是用户新授权/);
});

test('mock host: explicit goal edit is user-authorized after an automatic round, without refilling budget', async () => {
  const h = host(); await h.enable(2);
  assert.equal(h.controller.reserveWake(h.ctx), true);
  assert.equal((await h.call({ action: 'update', title: 'model expanded scope' })).isError, true);
  await h.commands.get('goal').handler('edit #1 User revised title', h.ctx);
  assert.equal(h.controller.snapshot().goals[0]!.title, 'User revised title');
  assert.equal(h.controller.snapshot().run.used, 1);
  assert.equal((await h.call({ action: 'update', maxTurns: 200 })).isError, true);
});
