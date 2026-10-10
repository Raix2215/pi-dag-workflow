import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTodo, emptyState } from '../src/todos/state.ts';
import { planViolation } from '../src/plan/policy.ts';

const batch = (state: ReturnType<typeof emptyState>, operations: object[]) => applyTodo(state, { action: 'batch', operations } as any);

test('batch creates a dependency chain and updates new tasks through batch-local refs', () => {
  const state = emptyState();
  const result = batch(state, [
    { action: 'create', ref: 'build', subject: 'Build' },
    { action: 'create', ref: 'review', subject: 'Review', blockedBy: ['@build'] },
    { action: 'update', id: '@review', description: 'Review actual artifacts', metadata: { evidence: 'pending' } },
  ]);
  assert.deepEqual(result.refs, { build: 1, review: 2 });
  assert.deepEqual(result.state.tasks[1]!.blockedBy, [1]);
  assert.equal(result.state.tasks[1]!.description, 'Review actual artifacts');
  assert.equal(result.state.nextId, 3); assert.deepEqual(state, emptyState());
  assert.deepEqual(result.operations!.map((operation) => operation.id), [undefined, undefined, 2]);
});

test('bad operations, unknown refs and cycles leave the original state and high-water id unchanged', () => {
  let state = applyTodo(emptyState(), { action: 'create', subject: 'Existing' }).state;
  state = applyTodo(state, { action: 'create', subject: 'Dependent', blockedBy: [1] }).state;
  const before = structuredClone(state);
  const failures = [
    [{ action: 'create', ref: 'new', subject: 'Discarded' }, { action: 'update', id: 999, subject: 'Missing' }],
    [{ action: 'create', subject: 'Unknown ref', blockedBy: ['@later'] }, { action: 'create', ref: 'later', subject: 'Later' }],
    [{ action: 'create', ref: 'same', subject: 'One' }, { action: 'create', ref: 'same', subject: 'Two' }],
    [{ action: 'update', id: 1, addBlockedBy: [2] }],
    [{ action: 'create', subject: 'Missing prerequisite', blockedBy: [999] }],
    [{ action: 'create', ref: '__proto__', subject: 'Bad ref' }],
  ];
  for (const operations of failures) { assert.throws(() => batch(state, operations)); assert.deepEqual(state, before); }
  assert.equal(applyTodo(state, { action: 'create', subject: 'Next' }).state.tasks.at(-1)!.id, 3);
});

test('batch accepts only pending creates and definition edits, including in Plan', () => {
  const state = { ...applyTodo(emptyState(), { action: 'create', subject: 'Existing' }).state, plan: true };
  const good = [{ action: 'create', ref: 'a', subject: 'New', status: 'pending' }, { action: 'update', id: 1, subject: 'Definition' }];
  assert.equal(planViolation(state, 'todo', { action: 'batch', operations: good }), undefined);
  assert.equal(batch(state, good).state.tasks[0]!.subject, 'Definition');
  for (const operation of [
    { action: 'create', subject: 'Start', status: 'in_progress' }, { action: 'update', id: 1, status: 'completed' },
    { action: 'update', id: 1, owner: 'new owner' }, { action: 'delete', id: 1 }, { action: 'clear' }, { action: 'apply', preset: 'example' }, { action: 'batch', operations: [] },
  ]) assert.throws(() => batch(state, [operation]));
  assert.ok(planViolation(state, 'todo', { action: 'batch', operations: [{ action: 'update', id: 1, status: 'completed' }] }));
});

test('batch is bounded, refs expire with the call, and a semantic no-op preserves canonical identity', () => {
  const state = applyTodo(emptyState(), { action: 'create', subject: 'Existing' }).state;
  assert.throws(() => batch(state, []));
  assert.throws(() => batch(state, Array.from({ length: 51 }, () => ({ action: 'create', subject: 'Too many' }))));
  const created = batch(state, [{ action: 'create', ref: 'constructor', subject: 'Safe name' }]);
  assert.equal(created.refs!.constructor, 2);
  assert.throws(() => batch(created.state, [{ action: 'update', id: '@constructor', subject: 'Expired ref' }]));
  const undone = batch(state, [{ action: 'update', id: 1, subject: 'Temporary' }, { action: 'update', id: 1, subject: 'Existing' }]);
  assert.equal(undone.state, state);
  assert.equal(undone.state.tasks[0], state.tasks[0]);
});

test('batch cannot edit deleted work or use a deleted prerequisite and does not reopen completed tasks', () => {
  let state = applyTodo(emptyState(), { action: 'create', subject: 'Closed' }).state;
  state = applyTodo(state, { action: 'update', id: 1, status: 'completed' }).state;
  assert.equal(batch(state, [{ action: 'update', id: 1, description: 'Evidence' }]).state.tasks[0]!.status, 'completed');
  state = applyTodo(state, { action: 'delete', id: 1 }).state;
  assert.throws(() => batch(state, [{ action: 'update', id: 1, subject: 'Deleted' }]));
  assert.throws(() => batch(state, [{ action: 'create', subject: 'Bad anchor', blockedBy: [1] }]));
});
