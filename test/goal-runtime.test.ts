import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerGoal } from '../src/goal-tools.ts';
import { emptyState } from '../src/todos.ts';
import { GOAL_TYPE, type GoalParams } from '../src/goals.ts';

function host() {
  const events = new Map<string, Function[]>();
  const tools = new Map<string, any>(); const commands = new Map<string, any>();
  let workflow = emptyState(); let jobs: any[] = []; let protectedState = false; let idle = false;
  const entries: any[] = []; const notifications: string[] = []; const wakes: any[] = [];
  const ctx: any = { cwd: '/tmp', mode: 'rpc', hasUI: true, isIdle: () => idle, sessionManager: { getBranch: () => entries }, ui: { notify: (text: string) => notifications.push(text), confirm: async () => true } };
  const pi: any = { on(name: string, handler: Function) { events.set(name, [...events.get(name) ?? [], handler]); return () => {}; }, registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand(name: string, cmd: any) { commands.set(name, cmd); }, appendEntry(customType: string, data: any) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); }, sendMessage(message: any, options: any) { wakes.push({ message, options }); }, sendUserMessage(message: string) { wakes.push({ message, options: { source: 'extension' } }); } };
  const controller = registerGoal(pi, { state: () => workflow, jobs: () => jobs, paint() {}, protected: () => protectedState, pauseAgents() {}, resumeAgents() {} });
  const fire = async (name: string, event: any = {}) => { let result: any; for (const handler of events.get(name) ?? []) result = await handler(event, ctx) ?? result; return result; };
  const call = async (params: GoalParams) => tools.get('goal').execute('test', params, undefined, undefined, ctx);
  const settle = (event: any = {}) => fire('agent_before_settle', { outcome: 'completed', continue: false, ...event });
  const enable = async (maxTurns = 20) => { await call({ action: 'create', title: '研究', maxTurns }); await fire('input', { source: 'rpc', text: '启用目标' }); assert.ok(!(await call({ action: 'enable', id: 1 })).isError); };
  return { ctx, controller, fire, call, settle, enable, entries, notifications, wakes, setPlan(value: boolean) { workflow = { ...workflow, plan: value }; }, setJobs(value: any[]) { jobs = value; }, setIdle(value: boolean) { idle = value; }, setProtected(value: boolean) { protectedState = value; }, commands };
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
  await h.call({ action: 'focus', id: 1 }); // User explicitly calls focus after the input, so this is a resume.
  assert.equal(state.run.used, 2);
});
test('mock host: Plan, restore and abort pause persistently; only explicit resume can rearm', async () => {
  const h = host(); await h.enable();
  h.controller.pause('进入 Plan', h.ctx); h.setPlan(true);
  assert.equal((await h.call({ action: 'create', title: '不应创建' })).isError, true);
  assert.equal((await h.call({ action: 'list' })).isError, undefined);
  h.setPlan(false); await h.fire('input', { source: 'rpc', text: '查看信息' });
  assert.equal(await h.settle(), undefined);
  await h.fire('session_tree');
  assert.equal(h.controller.snapshot().run.paused, true);
  await h.fire('input', { source: 'rpc', text: '恢复目标' }); await h.call({ action: 'resume' });
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
test('mock host: explicit idle resume reserves and starts once; unknown extra args cannot start work', async () => {
  const h = host(); await h.enable(); h.controller.pause('暂停', h.ctx); h.setIdle(true);
  await h.commands.get('goal').handler('resume extra arguments', h.ctx);
  assert.equal(h.wakes.length, 0);
  await h.commands.get('goal').handler('resume', h.ctx);
  assert.equal(h.wakes.length, 1);
  assert.equal(h.controller.snapshot().run.used, 1);
  assert.match(h.wakes[0].message, /Goal #1.*不是用户新授权/);
});
