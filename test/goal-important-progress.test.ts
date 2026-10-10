import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyGoal, emptyGoalState } from '../src/goal/state.ts';
import { registerGoal } from '../src/goal/register.ts';
import { emptyState } from '../src/todos/state.ts';
import { IsolatedClient } from './fixtures/isolated-client.ts';

const active = () => applyGoal(applyGoal(emptyGoalState(), { action: 'create', title: 'verify actual work' }).state, { action: 'enable', id: 1 }).state;
test('important notes preserve interior evidence; outer whitespace and duplicate notes are real no-ops', () => {
  let state = active();
  state = applyGoal(state, { action: 'update', progress: '  Compared "file  name"; 12 checks pass.  ', nextStep: '  inspect remaining failures  ' }).state;
  assert.equal(state.run.progress, 'Compared "file  name"; 12 checks pass.');
  assert.equal(state.run.nextStep, 'inspect remaining failures');
  assert.equal(applyGoal(state, { action: 'update', progress: '\nCompared "file  name"; 12 checks pass.\n', nextStep: '\ninspect remaining failures\n' }).state, state);
  assert.equal(applyGoal(state, { action: 'update', progress: 'A reproducible regression was found.' }).state.run.progress, 'A reproducible regression was found.');
});

test('tool guidance distinguishes milestones from per-turn reporting without adding a semantic classifier', () => {
  let tool: any;
  registerGoal({ on() {}, registerCommand() {}, registerTool(value: any) { tool = value; } } as any, { state: emptyState, jobs: () => [], paint() {}, protected: () => false, pauseAgents() {}, resumeAgents() {} });
  assert.match(tool.description, /verified milestone, reproducible finding, key decision, changed blocker/);
  assert.match(tool.description, /skip routine activity, repeated notes and Todo status/);
  assert.ok(tool.promptGuidelines.some((rule: string) => rule.includes('not every turn, tool call, wait or Todo update')));
  assert.ok(tool.promptGuidelines.some((rule: string) => rule.includes('same tool batch')));
});

test('actual offline Pi: repeated important notes do not write canonical state or reset progress', { timeout: 20000 }, async (t) => {
  const offline = new URL('./fixtures/offline-model.ts', import.meta.url).pathname;
  const client = await IsolatedClient.start(undefined, 'important-goal-notes', [], ['--dag-workflow-test-child-provider', offline]); t.after(() => client.close());
  await client.prompt('TEST CALL subagent_spawn {"task":"HOLD-IDLE-ENABLE-CHILD"}');
  await client.prompt('TEST CALL goal {"action":"create","title":"verify real results","maxTurns":8}');
  await client.prompt('/goal enable #1');
  await client.prompt('TEST CALL goal {"action":"update","progress":"12 checks pass"}');
  const snapshots = async () => (await client.entries() as any[]).filter((entry) => entry.customType === 'pi-dag-workflow.goal');
  const before = await snapshots();
  await client.prompt('TEST CALL goal {"action":"update","progress":" 12 checks pass "}');
  const after = await snapshots();
  assert.equal(after.length, before.length);
  assert.deepEqual(after.at(-1).data.run, before.at(-1).data.run);
  await client.prompt('/goal disable #1');
});
