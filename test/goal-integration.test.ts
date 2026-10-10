import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { GOAL_TYPE, type GoalState } from '../src/goal/state.ts';
import { STATE_TYPE } from '../src/todos/state.ts';
import { AGENTS_TYPE } from '../src/agents/register.ts';

const controls = fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url));
const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
const start = (root?: string) => IsolatedClient.start(root, 'm3-regression', [controls], ['--dag-workflow-test-child-provider', offline]);
const goals = (entries: unknown[]) => (entries as { customType?: string; data?: GoalState }[]).findLast((entry) => entry.customType === GOAL_TYPE)?.data;
const continuations = (entries: unknown[]) => (entries as any[]).filter((entry) => entry.type === 'custom_message' && entry.customType === 'pi-dag-workflow.goal-continue');
const widgets = (client: IsolatedClient) => client.records.filter((record) => record.method === 'setWidget').flatMap((record) => (record.widgetLines as string[] | undefined) ?? []).map(stripTerminalSequences).join('\n');
async function call(client: IsolatedClient, params: object) {
  const events = await client.prompt(`TEST CALL goal ${JSON.stringify(params)}`);
  const event = events.find((item) => item.type === 'tool_execution_end' && item.toolName === 'goal')!;
  assert.ok(event); const result = event.result as { isError?: boolean; details: any; content: { text: string }[] }; return { ...result, isError: event.isError === true || result.isError === true };
}

test('actual Pi: real focus header, shared budget reaches its cap and inspections cannot refill it', { timeout: 30000 }, async (t) => {
  const client = await start(); t.after(() => client.close());
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
test('actual Pi: regular research replans after eight repeated reports and completion remains explicit', { timeout: 30000 }, async (t) => {
  const client = await start(); t.after(() => client.close());
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
  let client = await start(); t.after(() => client.close());
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
  await client.close(false); client = await start(client.root);
  assert.ok(!client.records.some((record) => record.type === 'agent_start'));
  await call(client, { action: 'get' });
  assert.equal(continuations(await client.entries()).length, before);
});
test('actual Pi: waiting child does not poll; question wake uses the same Goal budget and late reports cannot bypass cap', { timeout: 30000 }, async (t) => {
  const client = await start(); t.after(() => client.close());
  await call(client, { action: 'create', title: '委派测试', maxTurns: 2 }); await call(client, { action: 'enable', id: 1 });
  // Child startup plus a real RPC round trip can exceed the default wait on a loaded CI runner.
  await client.until(() => client.records.some((record) => record.type === 'entry_appended' && (record.entry as any)?.customType === GOAL_TYPE && (record.entry as any)?.data?.run?.paused), 25000);
  // Report and child completion are asynchronous; wait for durable job state rather than sleep.
  await client.until(() => client.records.some((record) => record.type === 'entry_appended' && (record.entry as any)?.customType === AGENTS_TYPE && (record.entry as any)?.data?.jobs?.some((job: any) => job.status === 'completed')), 25000);
  let entries = await client.entries(); const state = goals(entries)!;
  assert.equal(state.run.used, 2); assert.match(state.run.reason!, /上限/);
  assert.equal(continuations(entries).length, 1);
  const reports = (entries as any[]).filter((entry) => entry.customType === 'pi-dag-workflow.agent-report');
  assert.equal(reports.length, 1, 'question wakes once; result is saved only after cap');
  await call(client, { action: 'get' }); entries = await client.entries();
  assert.equal(goals(entries)!.run.used, 2);
});
test('actual Pi without a compaction plugin: explicit enable wakes an active idle Goal using its remaining budget', { timeout: 30000 }, async (t) => {
  const client = await start(); t.after(() => client.close());
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

test('actual Pi: abort locks automatic work until explicit resume; zero phantom retry after status', { timeout: 30000 }, async (t) => {
  const client = await start(); t.after(() => client.close());
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
