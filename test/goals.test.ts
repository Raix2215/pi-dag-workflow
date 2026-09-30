import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyGoal, emptyGoalState, focusedGoal, pauseGoal, reserveGoalWake, restoreGoalState, validateGoalState, GOAL_TYPE, type GoalState } from '../src/goals.ts';

const create = (state: GoalState, title = '目标') => applyGoal(state, { action: 'create', title }).state;
test('goals are independent records; only enable/focus selects one active target', () => {
  let state = create(create(emptyGoalState(), 'A'), 'B');
  assert.equal(focusedGoal(state), undefined);
  assert.equal(state.goals[0]!.maxTurns, 20);
  state = applyGoal(state, { action: 'enable', id: 1 }).state;
  state = applyGoal(state, { action: 'switch', id: 2 }).state;
  assert.equal(focusedGoal(state)!.title, 'B');
  assert.equal(state.goals.filter((goal) => goal.status === 'active').length, 1);
  assert.equal(state.goals[0]!.status, 'paused');
});
test('same active focus cannot refill budget; explicit pause/resume can start a new allowance', () => {
  let state = applyGoal(create(emptyGoalState()), { action: 'enable', id: 1 }).state;
  state = reserveGoalWake(state)!;
  assert.equal(applyGoal(state, { action: 'focus', id: 1 }).state, state);
  assert.equal(state.run.used, 1);
  state = applyGoal(state, { action: 'disable' }).state;
  assert.equal(focusedGoal(state)!.id, 1, 'paused attention stays visible');
  assert.equal(reserveGoalWake(state), undefined);
  state = applyGoal(state, { action: 'resume' }).state;
  assert.equal(state.run.used, 0);
});
test('complete/delete clear focus, do not leave an invalid dangling id or revive tombstones', () => {
  for (const action of ['complete', 'delete'] as const) {
    const state = applyGoal(create(emptyGoalState()), { action: 'enable', id: 1 }).state;
    const next = applyGoal(state, { action }).state;
    assert.equal(next.focusId, undefined);
    assert.equal(next.run.paused, true);
    validateGoalState(next);
    assert.throws(() => applyGoal(next, { action: 'enable', id: 1 }), /已完成|已删除/);
    assert.throws(() => applyGoal(next, { action: 'update', id: 1, progress: 'no' }));
  }
});
test('one shared allowance is atomic and bounded; no progress checkpoint does not itself refill it', () => {
  let state = applyGoal(create(emptyGoalState()), { action: 'enable', id: 1 }).state;
  state = applyGoal(state, { action: 'update', maxTurns: 2, progress: '新发现', nextStep: '检查兼容' }).state;
  state = reserveGoalWake(state)!; state = reserveGoalWake(state)!;
  assert.equal(reserveGoalWake(state), undefined);
  assert.equal(state.run.used, 2);
  assert.equal(reserveGoalWake(pauseGoal(state, 'Plan')), undefined);
});
test('strict branch validation rejects future/corrupt snapshots, invalid ids and field types', () => {
  const state = create(emptyGoalState());
  const branch = [{ type: 'custom', customType: GOAL_TYPE, data: state }];
  assert.deepEqual(restoreGoalState(branch), state);
  assert.throws(() => restoreGoalState([...branch, { type: 'custom', customType: GOAL_TYPE, data: { ...state, version: 99 } }]), /损坏/);
  const mutations = [
    { ...state, goals: [state.goals[0], state.goals[0]] },
    { ...state, goals: [{ ...state.goals[0], id: -1 }] },
    { ...state, goals: [{ ...state.goals[0], title: null }] },
    { ...state, goals: [{ ...state.goals[0], description: 5 }] },
    { ...state, focusId: 999 }, { ...state, run: { ...state.run, used: -1 } },
  ];
  for (const value of mutations) assert.throws(() => validateGoalState(value as GoalState));
});
test('mutations validate and remain atomic, list/get are read-only, deleted rows stay hidden', () => {
  const state = create(emptyGoalState());
  assert.throws(() => applyGoal(state, { action: 'create', title: '' }));
  assert.throws(() => applyGoal(state, { action: 'update', id: 1 }));
  assert.throws(() => applyGoal(state, { action: 'create', title: 'X', maxTurns: 201 }));
  assert.throws(() => applyGoal(state, { action: 'update', id: 1, progress: 'before enabling' }));
  assert.equal(state.goals.length, 1);
  assert.equal(applyGoal(state, { action: 'get', id: 1 }).state, state);
  assert.equal(applyGoal(state, { action: 'list' }).state, state);
  const deleted = applyGoal(state, { action: 'delete', id: 1 }).state;
  assert.equal(applyGoal(deleted, { action: 'list' }).text, '暂无目标');
});
