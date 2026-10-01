import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerGoal } from '../src/goal/register.ts';
import { emptyState } from '../src/todos/state.ts';

test('initial Goal attention step is consumed while waiting; later child messages do not restart a polling loop', async () => {
  const events = new Map<string, Function>(); let tool: any;
  const ctx: any = { isIdle: () => false, ui: { notify() {} } };
  const pi: any = { on(name: string, fn: Function) { events.set(name, fn); }, registerTool(value: any) { tool = value; }, registerCommand() {}, appendEntry() {} };
  const goal = registerGoal(pi, { state: emptyState, jobs: () => [{ id: 'a1', status: 'running', profile: 'test' }], paint() {}, protected: () => false, pauseAgents() {}, resumeAgents() {} });
  await tool.execute('x', { action: 'create', title: '等待真实结果' }, undefined, undefined, ctx);
  events.get('input')!({ source: 'rpc', text: '启用' }, ctx);
  await tool.execute('x', { action: 'enable', id: 1 }, undefined, undefined, ctx);
  const settle = () => events.get('agent_before_settle')!({ outcome: 'completed', continue: false }, ctx);
  assert.equal(await settle(), undefined);
  assert.equal(goal.snapshot().run.nextStep, undefined);
  assert.equal(goal.reserveWake(ctx), true);
  assert.equal(await settle(), undefined);
  assert.equal(goal.snapshot().run.used, 1);
  assert.equal(goal.snapshot().run.paused, false);
});
