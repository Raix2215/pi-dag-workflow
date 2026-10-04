import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyTodo, clearTodoRecords, emptyState, type Todo, STATE_TYPE } from '../src/todos/state.ts';
import { planTaskCleanup } from '../src/todos/cleanup.ts';
import { AgentRuntime } from '../src/agents/runtime.ts';
import { ProfileStore } from '../src/agents/profiles.ts';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { foldAgentEntries } from '../src/agents/persistence.ts';

const task = (id: number, status: Todo['status'], blockedBy: number[] = []): Todo => ({ id, subject: `task ${id}`, status, blockedBy });
const history = fileURLToPath(new URL('./fixtures/history-records.ts', import.meta.url));
const controls = fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url));
const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
const fake = fileURLToPath(new URL('./fixtures/m2-rpc-fixture.mjs', import.meta.url));

test('closed cleanup removes failed/cancelled/deleted records and retains all dependency anchors', () => {
  const tasks = [task(1, 'completed'), task(2, 'pending', [1]), task(3, 'failed'), task(4, 'cancelled'), task(5, 'deleted'), task(6, 'failed'), task(7, 'pending', [6])];
  const result = planTaskCleanup(tasks, 'closed');
  assert.deepEqual(result.removedIds, [3, 4, 5]);
  assert.deepEqual(result.keptIds, [1, 6]);
  assert.deepEqual(result.tasks, [tasks[0], tasks[1], tasks[5], tasks[6]]);
  const state = clearTodoRecords({ ...emptyState(), tasks, nextId: 40 }, 'closed');
  assert.equal(state.state.nextId, 40);
  assert.deepEqual(state.state.tasks, result.tasks);
});

test('deleted tombstones do not pin completed history; retryable failed successors still retain anchors', () => {
  assert.deepEqual(planTaskCleanup([task(1, 'completed'), task(2, 'deleted', [1])], 'completed').removedIds, [1]);
  assert.deepEqual(planTaskCleanup([task(1, 'completed'), task(2, 'failed', [1])], 'completed').keptIds, [1]);
});

test('failed/cancelled never satisfy prerequisites; failed attempts can be explicitly retried', () => {
  let state = applyTodo(emptyState(), { action: 'create', subject: 'first' }).state;
  state = applyTodo(state, { action: 'create', subject: 'second', blockedBy: [1] }).state;
  for (const status of ['failed', 'cancelled'] as const) {
    state = applyTodo(state, { action: 'update', id: 1, status }).state;
    assert.throws(() => applyTodo(state, { action: 'update', id: 2, status: 'in_progress' }), /前置未完成/);
    state = applyTodo(state, { action: 'update', id: 1, status: 'pending' }).state;
  }
  assert.throws(() => applyTodo(state, { action: 'create', subject: 'bad', status: 'failed' }), /pending 或 in_progress/);
  assert.throws(() => applyTodo(state, { action: 'clear', id: 1 } as any), /不接受字段/);
});

test('cleanup protects active work and uses the same derived failure outcome as the view', () => {
  const tasks = [task(1, 'completed'), task(2, 'in_progress'), task(3, 'pending'), task(4, 'completed', [1])];
  const projected = new Map([[2, 'failed'], [3, 'cancelled']]);
  const result = planTaskCleanup(tasks, 'closed', new Set([1, 4]), projected);
  assert.deepEqual(result.removedIds, [2, 3]); assert.deepEqual(result.keptIds, [1, 4]);
  const none = clearTodoRecords({ ...emptyState(), tasks, nextId: 5 }, 'completed', new Set([1, 4]));
  assert.equal(none.state.tasks, tasks);
});

test('agent pruning never stops live jobs and preserves ID high-water after all history is removed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-prune-id-'));
  const model = { provider: 'dag-test', id: 'scripted' };
  const profiles = new ProfileStore({ registry: { find: () => model } });
  const runtime = new AgentRuntime({ cwd: root, profiles, getInheritedModel: () => model, testCliPath: fake });
  t.after(async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); });
  const running = await runtime.spawn({ task: 'HOLD' });
  assert.throws(() => runtime.prune([running.id]), /active agent/);
  assert.equal(runtime.activeCount(), 1);
  await runtime.cancel(running.id);
  runtime.prune([running.id]);
  const nextId = runtime.nextId();
  await runtime.importSummaries([], nextId);
  const second = await runtime.spawn({ task: 'HOLD' });
  assert.equal(second.id, `a${nextId}`);
  await assert.rejects(runtime.importSummaries(runtime.exportRecords(), nextId), /nextId/);
  assert.equal(runtime.activeCount(), 1, 'invalid restoration does not stop the current process');
});

async function call(client: IsolatedClient, name: string, params: object) {
  const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(params)}`);
  const result = events.find((event) => event.type === 'tool_execution_end' && event.toolName === name)!;
  assert.ok(result); return result;
}
async function retainedClient() {
  const client = await IsolatedClient.start(undefined, 'record-cleanup', [history, controls], ['--dag-workflow-test-child-provider', offline]);
  for (let id = 1; id <= 6; id++) await call(client, 'todo', { action: 'create', subject: `record ${id}` });
  for (const [id, status] of [[1, 'completed'], [2, 'failed'], [3, 'cancelled'], [4, 'completed'], [5, 'in_progress']] as const) await call(client, 'todo', { action: 'update', id, status });
  await call(client, 'todo', { action: 'update', id: 6, addBlockedBy: [1] });
  await client.prompt(`/test-history-records ${JSON.stringify([
    { id: 'a1', status: 'completed', reportDelivery: 'delivered' },
    { id: 'a2', status: 'failed', reportDelivery: 'delivered', todoId: 2 },
    { id: 'a3', status: 'cancelled', todoId: 3 },
    { id: 'a4', status: 'completed', reportDelivery: 'pending', todoId: 4 },
    { id: 'a5', status: 'completed', reportDelivery: 'delivered', todoId: 5 },
    { id: 'a6', status: 'failed', reportDelivery: 'pending' },
  ])}`);
  await client.prompt('/test-reload');
  return client;
}

test('real Pi closed cleanup includes main failed/cancelled and child records while preserving pending evidence/anchors', { timeout: 30000 }, async (t) => {
  const client = await retainedClient(); t.after(() => client.close());
  const clear = await call(client, 'todo', { action: 'clear', scope: 'closed' });
  assert.equal(clear.isError, false);
  let entries = await client.entries() as any[];
  const state = entries.findLast((entry) => entry.customType === STATE_TYPE).data;
  assert.deepEqual(state.tasks.map((task: Todo) => task.id), [1, 4, 5, 6]);
  assert.equal(state.nextId, 7);
  const agents = foldAgentEntries(entries);
  assert.deepEqual(agents.records.map((job) => job.id), ['a4', 'a5', 'a6']);
  assert.equal(agents.nextId, 20);
  await client.prompt('/test-reload');
  const inspect = await call(client, 'subagent_inspect', { profiles: true });
  assert.equal((inspect.result as any).details.jobs.length, 3);
  const spawned = await call(client, 'subagent_spawn', { task: 'HOLD-IDLE-ENABLE-CHILD' });
  assert.equal((spawned.result as any).details.jobId, 'a20');
});

test('real Pi invalid cleanup fields are rejected and completed cleanup does not remove failed records', { timeout: 30000 }, async (t) => {
  const client = await retainedClient(); t.after(() => client.close());
  const bad = await call(client, 'todo', { action: 'clear', scope: 'closed', id: 2 });
  assert.equal(bad.isError, true);
  await call(client, 'todo', { action: 'clear', scope: 'completed' });
  const entries = await client.entries() as any[];
  assert.ok(entries.findLast((entry) => entry.customType === STATE_TYPE).data.tasks.some((task: Todo) => task.id === 2 && task.status === 'failed'));
  assert.ok(foldAgentEntries(entries).records.some((job) => job.id === 'a2'));
});
