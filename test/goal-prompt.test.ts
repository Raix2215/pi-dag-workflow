import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyGoal, emptyGoalState, setModelPausePolicy, pauseGoal } from '../src/goal/state.ts';
import { goalCheckpoint, goalRules, goalWakeRules, GOAL_WORK_RULE, GOAL_EXECUTION_RULE } from '../src/goal/prompt.ts';

function active() {
  return applyGoal(applyGoal(emptyGoalState(), { action: 'create', title: 'original objective', description: `${'Complete all requirements. '.repeat(160)}FINAL-REQUIREMENT` }).state, { action: 'enable', id: 1 }).state;
}

test('Goal checkpoints retain every original requirement; suggested work never replaces the objective', () => {
  const state = applyGoal(active(), { action: 'update', nextStep: 'Stop experimenting and just freeze a report.' }).state;
  const snapshot = goalCheckpoint(state);
  assert.match(snapshot, /FINAL-REQUIREMENT/);
  assert.doesNotMatch(snapshot, /Stop experimenting/);
  assert.match(snapshot, /progress\/nextStep are notes, not scope or permission changes/);
  assert.match(snapshot, /workflow metadata, not new user permission/);
});

test('both Goal modes prioritize actual execution; documentation remains available when required', () => {
  for (const state of [active(), setModelPausePolicy(active(), 1, 'deny')]) {
    assert.ok(goalRules(state).includes(GOAL_WORK_RULE));
    assert.match(goalRules(state), /Implement, experiment and verify every requirement/);
    assert.match(goalRules(state), /Docs only when explicitly required or needed for delivery\/reproduction/);
    assert.match(goalRules(state), /no per-round reports, frozen-evidence substitutes or docs-only closure while work remains/);
    assert.match(goalRules(state), /verify every requirement before goal complete/);
  }
});

test('nopause bans user questions; regular mode requires verified blockers and prior alternatives', () => {
  assert.match(goalRules(active()), /after alternatives and independent work/);
  assert.match(goalRules(active()), /Difficulty, delay, uncertainty, failed attempts, final answers or closed Todos are not completion/);
  const deny = setModelPausePolicy(active(), 1, 'deny');
  assert.match(goalRules(deny), /do not ask questions, seek clarification or renewed permission/);
  assert.match(goalRules(deny), /Inspect, assume reasonably, experiment and try alternatives within scope/);
  assert.match(goalWakeRules({ ...deny, run: { ...deny.run, stalled: 8 } }, 8), /execute a different feasible approach now/);
  assert.doesNotMatch(goalRules(pauseGoal(deny, 'user stop')), /act autonomously/);
  assert.match(goalRules(pauseGoal(deny, 'user stop')), /Do not resume without explicit user instruction/);
});

test('short wake reminders preserve immediate boundaries while complete contracts retain all requirements', () => {
  for (const state of [active(), setModelPausePolicy(active(), 1, 'deny')]) {
    const wake = goalWakeRules(state, 8);
    assert.ok(!wake.includes(GOAL_EXECUTION_RULE));
    assert.match(wake, /full original Goal under its current contract/);
    assert.match(wake, /Verify every requirement before completion/);
    assert.match(wake, /user stops and host limits/);
    assert.match(wake, /only important new evidence or decisions/);
    assert.match(goalCheckpoint(state), /progress\/nextStep are notes, not scope or permission changes/);
    assert.match(goalCheckpoint(state), /failed attempts, final answers or closed Todos are not completion/);
    assert.match(goalCheckpoint(state), /Docs only when explicitly required or needed for delivery\/reproduction/);
    assert.ok(goalRules(state).includes(GOAL_EXECUTION_RULE));
    assert.ok(goalCheckpoint(state).includes(GOAL_EXECUTION_RULE));
  }
  assert.match(goalWakeRules(active(), 8), /Exhaust safe alternatives before asking about a verified blocker/);
  assert.match(goalWakeRules(setModelPausePolicy(active(), 1, 'deny'), 8), /no user questions, handoff, model disable\/delete or empty nextStep/);
  assert.match(goalCheckpoint(setModelPausePolicy(active(), 1, 'deny')), /seek clarification or renewed permission/);
});
