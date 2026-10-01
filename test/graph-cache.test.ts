import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dagStructure } from '../src/dag/cache.ts';
import { deriveDag } from '../src/dag/graph.ts';
import { applyTodo, emptyState } from '../src/todos/state.ts';

test('status/title/owner/progress mutations reuse topology while ready state remains fresh', () => {
  let state = applyTodo(emptyState(), { action: 'create', subject: 'A' }).state;
  state = applyTodo(state, { action: 'create', subject: 'B', blockedBy: [1] }).state;
  const topology = dagStructure(state.tasks);
  assert.deepEqual(deriveDag(state.tasks).ready, [1]);
  for (const params of [{ action: 'update', id: 1, subject: '新名称' }, { action: 'update', id: 1, owner: 'worker' }, { action: 'update', id: 1, activeForm: '检查中' }, { action: 'update', id: 1, status: 'completed' }] as const) {
    state = applyTodo(state, params).state;
    assert.equal(dagStructure(state.tasks), topology);
  }
  assert.deepEqual(deriveDag(state.tasks).ready, [2]);
  state = applyTodo(state, { action: 'update', id: 2, removeBlockedBy: [1] }).state;
  assert.notEqual(dagStructure(state.tasks), topology);
});
test('structural edits still reject cycles, missing dependencies and unsafe deletes atomically', () => {
  let state = applyTodo(emptyState(), { action: 'create', subject: 'A' }).state;
  state = applyTodo(state, { action: 'create', subject: 'B', blockedBy: [1] }).state;
  const topology = dagStructure(state.tasks);
  assert.throws(() => applyTodo(state, { action: 'update', id: 1, addBlockedBy: [2] }));
  assert.throws(() => applyTodo(state, { action: 'update', id: 2, addBlockedBy: [99] }));
  assert.throws(() => applyTodo(state, { action: 'delete', id: 1 }));
  assert.equal(dagStructure(state.tasks), topology);
});
