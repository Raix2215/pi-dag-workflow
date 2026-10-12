import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Value } from 'typebox/value';
import { fileURLToPath } from 'node:url';
import { applyTodo, emptyState, STATE_TYPE, TodoParamsSchema, type Todo, type WorkflowState } from '../src/todos/state.ts';
import { registerTodos } from '../src/todos/register.ts';
import { planViolation } from '../src/plan/policy.ts';
import { IsolatedClient } from './fixtures/isolated-client.ts';

const stateOf = (statuses: Todo['status'][]): WorkflowState => ({
  ...emptyState(),
  nextId: statuses.length + 1,
  tasks: statuses.map((status, index) => ({ id: index + 1, subject: `Task ${index + 1}`, status, blockedBy: [] })),
});

function toolHost(initial: WorkflowState, isProtected = false) {
  let state = initial;
  let writes = 0;
  let tool: any;
  const pi: any = { on() {}, registerCommand() {}, registerTool(value: any) { tool = value; } };
  registerTodos(pi, {
    state: () => state,
    protected: () => isProtected,
    commit(next) { state = next; },
    reset() {},
    async show() {},
    mutate(params) { const result = applyTodo(state, params); if (result.state !== state) writes++; state = result.state; return result; },
  });
  return { call: (params: any) => tool.execute('status-test', params, undefined, undefined, {}), writes: () => writes, state: () => state };
}

test('pure status summary is read-only and reports every status plus a separate deleted count', () => {
  const state = stateOf(['pending', 'pending', 'in_progress', 'completed', 'failed', 'cancelled', 'deleted']);
  const before = structuredClone(state);
  const result = applyTodo(state, { action: 'status' });
  assert.equal(result.state, state, 'status returns the same state reference: nothing is committed');
  assert.deepEqual(result.status, {
    mode: 'normal',
    total: 6,
    counts: { pending: 2, in_progress: 1, completed: 1, failed: 1, cancelled: 1 },
    deleted: 1,
  });
  assert.deepEqual(JSON.parse(result.text), result.status, 'content text is the readable JSON summary');
  assert.deepEqual(state, before, 'the canonical list and IDs are untouched');
  assert.equal(state.nextId, 8);
});

test('status reports plan mode and Plan allows only the read-only query', () => {
  const state = { ...stateOf(['pending', 'completed']), plan: true };
  assert.equal(applyTodo(state, { action: 'status' }).status!.mode, 'plan');
  assert.equal(planViolation(state, 'todo', { action: 'status' }), undefined);
  assert.ok(planViolation(state, 'todo', { action: 'update', id: 1, status: 'completed' }));
});

test('schema and field guard accept status with no extra arguments', () => {
  assert.equal(Value.Check(TodoParamsSchema, { action: 'status' }), true);
  assert.equal(Value.Check(TodoParamsSchema, { action: 'status', nope: true }), false);
  for (const extra of [{ id: 1 }, { limit: 5 }, { status: 'pending' }, { subject: 'x' }]) {
    assert.throws(() => applyTodo(emptyState(), { action: 'status', ...extra } as never), /不接受/);
  }
});

test('todo tool status puts readable JSON in content and no tasks snapshot in details', async () => {
  const host = toolHost(stateOf(['pending', 'completed', 'deleted']));
  const result = await host.call({ action: 'status' });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const parsed = JSON.parse(result.content[0]!.text);
  assert.deepEqual(parsed, {
    mode: 'normal',
    total: 2,
    counts: { pending: 1, in_progress: 0, completed: 1, failed: 0, cancelled: 0 },
    deleted: 1,
    protected: false,
  });
  assert.equal('tasks' in result.details, false);
  assert.equal('nextId' in result.details, false);
  assert.deepEqual(result.details.status, parsed);
  assert.equal(host.writes(), 0, 'status never commits state');
});

test('protected state still answers status and flags it without a snapshot', async () => {
  const host = toolHost({ ...emptyState(), plan: true }, true);
  const result = await host.call({ action: 'status' });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const parsed = JSON.parse(result.content[0]!.text);
  assert.equal(parsed.protected, true);
  assert.equal(parsed.total, 0);
  assert.equal('tasks' in result.details, false);
  assert.equal(host.writes(), 0);
});

async function call(client: IsolatedClient, params: object) {
  const events = await client.prompt(`TEST CALL todo ${JSON.stringify(params)}`);
  const event = events.find((record) => record.type === 'tool_execution_end' && record.toolName === 'todo')!;
  assert.ok(event, 'todo executed');
  return { ...(event.result as any), isError: event.isError === true || (event.result as any).isError === true };
}

test('actual Pi: a corrupt Todo record stays protected while status still reports normal mode', { timeout: 30000 }, async (t) => {
  const controls = fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url));
  const client = await IsolatedClient.start(undefined, 'protected-status', [controls]);
  t.after(() => client.close());
  await client.prompt('/test-corrupt'); await client.prompt('/test-reload');
  const before = (await client.entries() as any[]).filter((entry) => entry.customType === STATE_TYPE).length;
  const result = await call(client, { action: 'status' });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(JSON.parse(result.content[0].text).protected, true);
  assert.equal(JSON.parse(result.content[0].text).mode, 'normal', 'a broken Todo record is not a global Plan error');
  assert.equal((await client.entries() as any[]).filter((entry) => entry.customType === STATE_TYPE).length, before);
});

test('actual Pi: one todo status query answers mode, counts and protection without a snapshot', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start();
  t.after(() => client.close());
  assert.equal((await call(client, { action: 'create', subject: 'first' })).isError, false);
  assert.equal((await call(client, { action: 'create', subject: 'second', status: 'in_progress' })).isError, false);
  assert.equal((await call(client, { action: 'update', id: 1, status: 'completed' })).isError, false);
  const status = await call(client, { action: 'status' });
  assert.equal(status.isError, false, JSON.stringify(status));
  const parsed = JSON.parse(status.content[0].text);
  assert.equal(parsed.mode, 'normal');
  assert.equal(parsed.total, 2);
  assert.deepEqual(parsed.counts, { pending: 0, in_progress: 1, completed: 1, failed: 0, cancelled: 0 });
  assert.equal(parsed.deleted, 0);
  assert.equal(parsed.protected, false);
  assert.equal('tasks' in status.details, false);
  assert.equal('nextId' in status.details, false);
});
