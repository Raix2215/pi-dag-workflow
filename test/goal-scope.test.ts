import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerGoal } from '../src/goal-tools.ts';
import { emptyState } from '../src/todos.ts';

test('automatic model cannot enlarge its allowance or silently switch objectives', async () => {
  const handlers = new Map<string, Function>(); let tool: any;
  const ctx: any = { isIdle: () => false, ui: { notify() {} } };
  const pi: any = { on(event: string, handler: Function) { handlers.set(event, handler); }, registerTool(value: any) { tool = value; }, registerCommand() {}, appendEntry() {}, sendUserMessage() {} };
  const control = registerGoal(pi, { state: emptyState, jobs: () => [], paint() {}, protected: () => false, pauseAgents() {}, resumeAgents() {} });
  const call = (args: any) => tool.execute('id', args, undefined, undefined, ctx);
  await call({ action: 'create', title: 'A', maxTurns: 2 });
  await call({ action: 'create', title: 'B' });
  handlers.get('input')!({ source: 'rpc', text: '启用 A' }, ctx);
  await call({ action: 'enable', id: 1 });
  assert.equal(control.reserveWake(ctx), true);
  assert.equal((await call({ action: 'update', maxTurns: 200 })).isError, true);
  assert.equal((await call({ action: 'switch', id: 2 })).isError, true);
  assert.equal((await call({ action: 'update', progress: '新事实', nextStep: '继续核查' })).isError, undefined);
  assert.equal(control.snapshot().goals[0]!.maxTurns, 2);
  assert.equal(control.snapshot().focusId, 1);
  handlers.get('input')!({ source: 'rpc', text: '我明确要求切换到 B' }, ctx);
  assert.equal((await call({ action: 'switch', id: 2 })).isError, undefined);
  assert.equal(control.snapshot().focusId, 2);
});
