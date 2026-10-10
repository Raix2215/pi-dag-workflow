import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerGoal } from '../src/goal/register.ts';
import { emptyState } from '../src/todos/state.ts';
import { applyGoal, emptyGoalState, setModelPausePolicy, GOAL_TYPE } from '../src/goal/state.ts';
import { goalCheckpoint, GOAL_CHECKPOINT_TYPE, hasCurrentGoalContract } from '../src/goal/prompt.ts';
import { IsolatedClient } from './fixtures/isolated-client.ts';

const active = () => applyGoal(applyGoal(emptyGoalState(), { action: 'create', title: 'current objective', description: 'FINAL-REQUIREMENT' }).state, { action: 'enable', id: 1 }).state;
const contract = (state: ReturnType<typeof active>) => ({ role: 'custom', customType: GOAL_CHECKPOINT_TYPE, content: goalCheckpoint(state) });

test('contract matching preserves all authority fields but ignores used/progress/nextStep counters', () => {
  const state = active(); const message = contract(state);
  assert.equal(hasCurrentGoalContract([message], state), true);
  assert.equal(hasCurrentGoalContract([message], { ...state, run: { ...state.run, used: 6, progress: 'new evidence', nextStep: 'changed note' } }), true);
  assert.equal(hasCurrentGoalContract([message], applyGoal(state, { action: 'update', description: 'CHANGED-TAIL' }).state), false);
  assert.equal(hasCurrentGoalContract([message], setModelPausePolicy(state, 1, 'deny')), false);
  assert.equal(hasCurrentGoalContract([{ ...message, content: message.content.replace('FINAL-REQUIREMENT', 'cropped') }], state), false);
  assert.equal(hasCurrentGoalContract([{ ...message, content: 'Goal contract (\nmalformed' }], state), false);
});

test('final context appends only the current contract, never edits a system/summary/report or wakes a turn', async () => {
  const handlers = new Map<string, Function[]>(); const entries: any[] = [{ type: 'custom', customType: GOAL_TYPE, data: active() }];
  let tool: any;
  const pi: any = { on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); }, registerCommand() {}, registerTool(value: any) { tool = value; }, appendEntry(type: string, data: any) { entries.push({ type: 'custom', customType: type, data }); }, sendMessage() { throw Error('unexpected wake'); } };
  const controller = registerGoal(pi, { state: emptyState, jobs: () => [], paint() {}, protected: () => false, pauseAgents() {}, resumeAgents() {} });
  const ctx: any = { isIdle: () => false, sessionManager: { getBranch: () => entries }, ui: { notify() {} } };
  // A restore must pause; use the public state tool only after a user input for explicit enable.
  for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx);
  assert.equal(controller.snapshot().run.paused, true);
  const leading = { role: 'system', content: 'native prompt', sections: { rules: 'native rules' } };
  const finalContext = handlers.get('context_with_system')![0]!;
  assert.equal(await finalContext({ messages: [leading] }, ctx), undefined);
  for (const handler of handlers.get('input') ?? []) await handler({ source: 'rpc', text: 'explicitly enable' }, ctx);
  assert.ok(!(await tool.execute('enable', { action: 'enable', id: 1 }, undefined, undefined, ctx)).isError);
  const summary = { role: 'compactionSummary', summary: 'owned by memory' };
  const report = { role: 'custom', customType: 'pi-dag-workflow.agent-report', content: 'do not replay or edit' };
  const original = [leading, summary, report];
  const result = await finalContext({ messages: original }, ctx);
  assert.deepEqual(original, [leading, summary, report]);
  assert.equal(result.messages[0], leading); assert.equal(result.messages[1], summary); assert.equal(result.messages[2], report);
  assert.equal(result.messages.length, 4); assert.equal(result.messages[3].customType, GOAL_CHECKPOINT_TYPE);
  assert.match(result.messages[3].content, /FINAL-REQUIREMENT/);
  assert.equal(await finalContext({ messages: result.messages }, ctx), undefined);
  controller.pause('user stopped', ctx);
  assert.equal(await finalContext({ messages: original }, ctx), undefined);
  for (const handler of handlers.get('session_shutdown') ?? []) await handler({}, ctx);
});

for (const memoryFirst of [true, false]) test(`actual Pi: short wakes keep complete requirements even when ordinary memory hides all contracts (${memoryFirst ? 'before' : 'after'} workflow)`, { timeout: 30000 }, async (t) => {
  const memory = new URL('./fixtures/goal-compaction.ts', import.meta.url).pathname;
  const project = new URL('../', import.meta.url).pathname;
  const client = await IsolatedClient.start(undefined, 'missing-contract-final', memoryFirst ? [] : [memory], ['--dag-test-context-export'], false, memoryFirst ? [memory, project] : undefined); t.after(() => client.close());
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
  assert.ok(!entries.some((entry) => entry.customType === 'pi-dag-workflow.goal-retry'));
});
