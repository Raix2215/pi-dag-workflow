import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTodo, emptyState, restoreState, STATE_TYPE, type Todo, type WorkflowState } from '../src/todos/state.ts';
import { registerTodos } from '../src/todos/register.ts';

const stateOf = (count: number): WorkflowState => ({ ...emptyState(), nextId: count + 1, tasks: Array.from({ length: count }, (_, i) => ({ id: i + 1, subject: `Task ${i + 1}`, status: 'pending', blockedBy: [] })) });
function toolHost(initial: WorkflowState) {
  let state = initial; let writes = 0; let tool: any;
  const pi: any = { on() {}, registerCommand() {}, registerTool(value: any) { tool = value; } };
  registerTodos(pi, { state: () => state, protected: () => false, commit(next) { state = next; }, reset() {}, async show() {}, mutate(params) { const result = applyTodo(state, params); if (result.state !== state) writes++; state = result.state; return result; } });
  return { call: (params: any) => tool.execute('read-test', params, undefined, undefined, {}), render: (result: any, expanded: boolean) => tool.renderResult(result, { expanded }, { fg: (_key: string, value: string) => value }).render(180), writes: () => writes };
}

test('default list is bounded and all 10,000 tasks can be retrieved with the returned cursor', () => {
  const state = stateOf(10000);
  const first = applyTodo(state, { action: 'list' });
  assert.equal(first.tasks?.length, 50);
  assert.equal(first.page?.total, 10000);
  const ids: number[] = []; let afterId = 0;
  for (;;) {
    const result = applyTodo(state, { action: 'list', limit: 200, afterId } as any);
    assert.equal(result.state, state);
    ids.push(...result.tasks!.map((task: Todo) => task.id));
    if (result.page?.nextAfterId === undefined) break;
    afterId = result.page.nextAfterId;
  }
  assert.deepEqual(ids, state.tasks.map((task) => task.id));
});

test('cursor pagination filters before counting and handles insertion, deletion and unordered imports', () => {
  let state = stateOf(6);
  state = { ...state, tasks: [state.tasks[5]!, ...state.tasks.slice(0, 5)] };
  const first = applyTodo(state, { action: 'list', limit: 2 } as any);
  assert.deepEqual(first.tasks!.map((task: Todo) => task.id), [1, 2]);
  state = applyTodo(state, { action: 'delete', id: 3 }).state;
  state = applyTodo(state, { action: 'create', subject: 'new task' }).state;
  const next = applyTodo(state, { action: 'list', limit: 200, afterId: first.page!.nextAfterId } as any);
  assert.deepEqual(next.tasks!.map((task: Todo) => task.id), [4, 5, 6, 7]);
  assert.equal(next.page!.total, 6);
  assert.deepEqual(applyTodo(state, { action: 'list', status: 'deleted', includeDeleted: true } as any).tasks!.map((task: Todo) => task.id), [3]);
  assert.equal(applyTodo(state, { action: 'list', afterId: 999 } as any).tasks!.length, 0);
  for (const params of [{ action: 'list', limit: 0 }, { action: 'list', limit: 201 }, { action: 'list', afterId: -1 }, { action: 'list', limit: 1.5 }]) assert.throws(() => applyTodo(state, params as any));
});

test('ready and get relationships derive from current statuses without adding persisted graph state', () => {
  let state = stateOf(3);
  state = applyTodo(state, { action: 'update', id: 2, addBlockedBy: [1] }).state;
  state = applyTodo(state, { action: 'update', id: 3, addBlockedBy: [2] }).state;
  for (const status of ['pending', 'failed', 'cancelled'] as const) {
    state = applyTodo(state, { action: 'update', id: 1, status }).state;
    assert.deepEqual(applyTodo(state, { action: 'list', ready: true } as any).tasks!.map((task: Todo) => task.id), status === 'pending' ? [1] : []);
  }
  state = applyTodo(state, { action: 'update', id: 1, status: 'completed' }).state;
  assert.deepEqual(applyTodo(state, { action: 'list', ready: true } as any).tasks!.map((task: Todo) => task.id), [2]);
  const task = JSON.parse(applyTodo(state, { action: 'get', id: 2 }).text);
  assert.deepEqual(task.blocks, [3]); assert.deepEqual(task.unmetPrerequisites, []);
  assert.deepEqual(JSON.parse(applyTodo(state, { action: 'get', id: 3 }).text).unmetPrerequisites, [2]);
  assert.throws(() => applyTodo(state, { action: 'list', ready: true, status: 'completed' } as any));
});

test('read, single mutation and no-op details are compact; rendering expands only the current page', async () => {
  const state = stateOf(1000); const h = toolHost(state);
  const list = await h.call({ action: 'list' });
  assert.equal(list.details.version, 2); assert.equal(list.details.tasks.length, 50);
  assert.equal(list.details.page.total, 1000);
  assert.ok(h.render(list, false).length <= 6);
  assert.ok(h.render(list, true).length >= 50);
  assert.match(h.render(list, false).join('\n'), /afterId/);
  const get = await h.call({ action: 'get', id: 7 });
  assert.deepEqual(get.details.tasks.map((task: Todo) => task.id), [7]);
  const noOp = await h.call({ action: 'update', id: 7, subject: 'Task 7' });
  assert.ok(noOp.details.tasks.length <= 1); assert.equal(h.writes(), 0);
  const update = await h.call({ action: 'update', id: 7, subject: 'Updated' });
  assert.deepEqual(update.details.tasks.map((task: Todo) => task.id), [7]); assert.equal(h.writes(), 1);
  assert.ok(JSON.stringify(get.details).length < JSON.stringify(state.tasks).length / 50);
  const nothing = await h.call({ action: 'clear', scope: 'completed' });
  assert.deepEqual(nothing.details.tasks, []); assert.equal(h.writes(), 1);
  await h.call({ action: 'update', id: 7, status: 'completed' });
  const cleared = await h.call({ action: 'clear', scope: 'completed' });
  assert.deepEqual(cleared.details.tasks, []); assert.deepEqual(cleared.details.removedIds, [7]);
  assert.equal((await h.call({ action: 'list' })).details.page.total, 999);
});

test('compact tool results never become a full-state import and canonical branches still win', () => {
  const state = stateOf(100);
  const old = { type: 'message', message: { role: 'toolResult', toolName: 'todo', details: { tasks: state.tasks, nextId: state.nextId } } };
  const compact = { type: 'message', message: { role: 'toolResult', toolName: 'todo', details: { version: 2, tasks: [state.tasks[5]], nextId: state.nextId } } };
  assert.deepEqual(restoreState([old, compact]).tasks, state.tasks);
  assert.deepEqual(restoreState([compact]).tasks, []);
  const changed = applyTodo(state, { action: 'update', id: 2, subject: 'branch definition' }).state;
  assert.deepEqual(restoreState([old, { type: 'custom', customType: STATE_TYPE, data: changed }, compact]).tasks, changed.tasks);
});
