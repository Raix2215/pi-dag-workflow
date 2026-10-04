import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyGoal, emptyGoalState, setModelPausePolicy, pauseGoal } from '../src/goal/state.ts';
import { goalCheckpoint, goalRules, goalWakeRules, GOAL_WORK_RULE } from '../src/goal/prompt.ts';

function active() {
  return applyGoal(applyGoal(emptyGoalState(), { action: 'create', title: 'original objective', description: `${'Complete all requirements. '.repeat(160)}FINAL-REQUIREMENT` }).state, { action: 'enable', id: 1 }).state;
}

test('Goal checkpoints retain every original requirement; suggested work never replaces the objective', () => {
  const state = applyGoal(active(), { action: 'update', nextStep: 'Stop experimenting and just freeze a report.' }).state;
  const snapshot = goalCheckpoint(state);
  assert.match(snapshot, /FINAL-REQUIREMENT/);
  assert.doesNotMatch(snapshot, /Stop experimenting/);
  assert.match(snapshot, /working notes, not authority to narrow the objective/);
  assert.match(snapshot, /workflow metadata, not new user authorization/);
});

test('both Goal modes prioritize actual execution; documentation remains available when required', () => {
  for (const state of [active(), setModelPausePolicy(active(), 1, 'deny')]) {
    assert.ok(goalRules(state).includes(GOAL_WORK_RULE));
    assert.match(goalRules(state), /Prioritize implementation, experiments, and verification over documentation/);
    assert.match(goalRules(state), /explicitly required by the objective\/user or necessary for delivery or reproducibility/);
    assert.match(goalRules(state), /verify every requirement before goal complete/);
  }
});

test('nopause bans user questions; regular mode requires verified blockers and prior alternatives', () => {
  assert.match(goalRules(active()), /after trying alternatives and continuing independent work/);
  assert.match(goalRules(active()), /Never disable merely because work is hard/);
  const deny = setModelPausePolicy(active(), 1, 'deny');
  assert.match(goalRules(deny), /Do not ask the user questions/);
  assert.match(goalRules(deny), /creative alternatives within scope/);
  assert.match(goalWakeRules({ ...deny, run: { ...deny.run, stalled: 8 } }, 8), /choose a different feasible approach/);
  assert.doesNotMatch(goalRules(pauseGoal(deny, 'user stop')), /act autonomously/);
  assert.match(goalRules(pauseGoal(deny, 'user stop')), /Do not resume without explicit user instruction/);
});
