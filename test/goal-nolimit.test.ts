import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Value } from 'typebox/value';
import { registerGoal } from '../src/goal/register.ts';
import { applyGoal, emptyGoalState, goalBudgetSpent, goalLimitLabel, goalNolimit, GoalParamsSchema, restoreGoalState, setGoalNolimit, validateGoalState, GOAL_TYPE } from '../src/goal/state.ts';
import { emptyState } from '../src/todos/state.ts';
import { IsolatedClient } from './fixtures/isolated-client.ts';

// ---------------------------------------------------------------------------
// State: the unlimited flag is user-owned, defaults to finite, and never edits run
// ---------------------------------------------------------------------------

test('nolimit defaults finite, survives enable/restore, and never touches the run', () => {
  let state = applyGoal(emptyGoalState(), { action: 'create', title: 'A', maxTurns: 2 }).state;
  assert.equal(goalNolimit(state.goals[0]!), false);
  assert.equal(goalLimitLabel(state.goals[0]!), '2');
  state = applyGoal(state, { action: 'enable', id: 1 }).state;
  const run = state.run;
  const unlimited = setGoalNolimit(state, 1, true);
  assert.equal(unlimited.run, run, 'the menu must not clear used, pendingWake or paused');
  assert.equal(goalNolimit(unlimited.goals[0]!), true);
  assert.equal(goalLimitLabel(unlimited.goals[0]!), '∞');
  assert.equal(unlimited.goals[0]!.maxTurns, 2, 'the original finite cap is retained for a later switch back');
  assert.deepEqual(restoreGoalState([{ type: 'custom', customType: GOAL_TYPE, data: unlimited }]), unlimited);
  // The user-owned flag outlives disable/enable and is idempotent.
  const disabled = applyGoal(unlimited, { action: 'disable', id: 1 }).state;
  assert.equal(applyGoal(disabled, { action: 'enable', id: 1 }).state.goals[0]!.nolimit, true);
  assert.equal(setGoalNolimit(unlimited, 1, true), unlimited);
  assert.throws(() => setGoalNolimit(unlimited, 99, true), /找不到/);
});

test('the unlimited flag validates as boolean and rejects corrupt values', () => {
  const state = applyGoal(emptyGoalState(), { action: 'create', title: 'A' }).state;
  assert.throws(() => validateGoalState({ ...state, goals: [{ ...state.goals[0]!, nolimit: 'yes' as never }] }), /额度/);
  assert.throws(() => setGoalNolimit(state, 1, 'yes' as never), /额度/);
  // The model tool schema has no nolimit field and no nolimit action.
  assert.equal(Value.Check(GoalParamsSchema, { action: 'update', nolimit: true }), false);
  assert.equal(Value.Check(GoalParamsSchema, { action: 'nolimit' }), false);
  assert.throws(() => applyGoal(state, { action: 'update', id: 1, nolimit: true } as never), /不接受字段/);
});

test('goalBudgetSpent is the shared gate and always affords an unlimited Goal', () => {
  let state = applyGoal(emptyGoalState(), { action: 'create', title: 'A', maxTurns: 1 }).state;
  state = applyGoal(state, { action: 'enable', id: 1 }).state;
  assert.equal(goalBudgetSpent(state, state.goals[0]!), false);
  const spent = { ...state, run: { ...state.run, used: 1 } };
  assert.equal(goalBudgetSpent(spent, spent.goals[0]!), true);
  const unlimited = setGoalNolimit(spent, 1, true);
  assert.equal(goalBudgetSpent(unlimited, unlimited.goals[0]!), false, 'unlimited Goals never exhaust allowance');
});

// ---------------------------------------------------------------------------
// In-process host: real hook/command wiring
// ---------------------------------------------------------------------------

function host() {
  const events = new Map<string, Function[]>(); const commands = new Map<string, any>(); const tools = new Map<string, any>();
  const entries: any[] = []; const notices: string[] = []; const wakes: any[] = [];
  let workflow = emptyState();
  let selection: (title: string, options: string[]) => Promise<string | undefined> = async (_title, options) => options[1];
  const fire = async (name: string, data: any = {}) => { let result: any; for (const handler of events.get(name) ?? []) result = await handler(data, ctx) ?? result; return result; };
  const ctx: any = { hasUI: true, mode: 'rpc', cwd: '/tmp', isIdle: () => false, sessionManager: { getBranch: () => entries }, ui: { notify: (text: string) => notices.push(text), select: async (title: string, options: string[]) => { await fire('ui_prompt_start', { kind: 'select', title }); return selection(title, options); } } };
  const pi: any = { on(name: string, handler: Function) { events.set(name, [...events.get(name) ?? [], handler]); }, registerCommand(name: string, command: any) { commands.set(name, command); }, registerTool(tool: any) { tools.set(tool.name, tool); }, appendEntry(customType: string, data: unknown) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); }, sendMessage(message: any) { wakes.push(message); }, sendUserMessage(message: string) { wakes.push(message); } };
  const controller = registerGoal(pi, { state: () => workflow, jobs: () => [], paint() {}, protected: () => false, pauseAgents() {}, resumeAgents() {} });
  const call = async (params: any) => tools.get('goal').execute('nolimit-test', params, undefined, undefined, ctx);
  const command = async (args: string) => commands.get('goal').handler(args, ctx);
  const enable = async (maxTurns = 2) => { await call({ action: 'create', title: '目标', maxTurns }); await fire('input', { source: 'rpc', text: '启用目标' }); await call({ action: 'enable', id: 1 }); };
  return { controller, ctx, call, command, fire, enable, entries, notices, wakes, select(fn: typeof selection) { selection = fn; }, plan(value: boolean) { workflow = { ...workflow, plan: value }; } };
}

test('an unlimited Goal keeps reserving Goal and child wakes past maxTurns and still counts used', async () => {
  const h = host(); await h.enable(2);
  h.select(async (_title, options) => options[1]); // finite -> unlimited
  await h.command('nolimit #1');
  assert.equal(h.controller.snapshot().goals[0]!.nolimit, true);
  for (let round = 0; round < 5; round++) assert.equal(h.controller.reserveWake(h.ctx), true, `round ${round}`);
  assert.equal(h.controller.snapshot().run.used, 5);
  assert.equal(h.controller.snapshot().run.paused, false);
  assert.equal(h.controller.canWake(), true, 'an over-cap unlimited Goal still admits child reports');
  // Sibling entries share one upcoming request even over the finite cap.
  assert.equal(h.controller.reserveWake(h.ctx, true), true);
  assert.equal(h.controller.reserveWake(h.ctx, true), true);
  assert.equal(h.controller.snapshot().run.used, 6);
  await h.fire('session_shutdown');
});

test('switching back to finite is passive and stops only at the next admission', async () => {
  const h = host(); await h.enable(2);
  h.select(async (_title, options) => options[1]);
  await h.command('nolimit #1');
  h.controller.reserveWake(h.ctx); h.controller.reserveWake(h.ctx); h.controller.reserveWake(h.ctx);
  const before = h.controller.snapshot();
  assert.equal(before.run.used, 3);
  await h.command('nolimit #1'); // unlimited -> finite, same default selection
  const after = h.controller.snapshot();
  assert.equal(after.goals[0]!.nolimit, false);
  assert.equal(after.goals[0]!.maxTurns, 2, 'maxTurns survives the round trip');
  assert.deepEqual(after.run, before.run, 'the switch clears no budget and does not pause');
  assert.equal(after.focusId, before.focusId);
  assert.equal(h.wakes.length, 0, 'the menu is not a start or resume');
  // Only the next normal admission observes the restored finite cap.
  assert.equal(await h.fire('agent_before_settle', { outcome: 'completed', entries: [], continue: false }), undefined);
  assert.equal(h.controller.snapshot().run.paused, true);
  assert.match(h.controller.snapshot().run.reason!, /上限/);
  assert.equal(h.controller.snapshot().run.used, 3);
  await h.fire('session_shutdown');
});

test('switching an un-enabled Goal to unlimited neither starts nor pauses it', async () => {
  const h = host();
  await h.call({ action: 'create', title: 'idle', maxTurns: 2 });
  const before = h.controller.snapshot();
  const commits = h.entries.length;
  await h.command('nolimit #1');
  const after = h.controller.snapshot();
  assert.equal(after.goals[0]!.nolimit, true);
  assert.equal(after.run.paused, true);
  assert.equal(after.run.used, before.run.used);
  assert.equal(after.focusId, before.focusId);
  assert.equal(h.wakes.length, 0);
  assert.equal(h.entries.length, commits + 1, 'one passive state commit');
  await h.fire('session_shutdown');
});

test('an un-enabled Goal stays asleep after switching back to finite and Plan/restore protect it', async () => {
  const h = host(); await h.enable(2);
  h.select(async (_title, options) => options[1]);
  await h.command('nolimit #1');
  h.controller.pause('进入 Plan', h.ctx); h.plan(true);
  await h.command('nolimit #1');
  assert.equal(h.controller.snapshot().goals[0]!.nolimit, false);
  assert.equal(h.controller.snapshot().run.paused, true, 'a plan pause is never lifted by the menu');
  h.plan(false);
  await h.fire('session_tree');
  assert.equal(h.controller.snapshot().goals[0]!.nolimit, false, 'the user choice is restored from the branch');
  assert.equal(h.controller.snapshot().run.paused, true, 'restore keeps the Goal paused');
  assert.equal(await h.fire('agent_before_settle', { outcome: 'completed', entries: [], continue: false }), undefined);
  await h.fire('session_shutdown');
});

test('nopause and nolimit share one menu guard; a stale menu writes nothing', async () => {
  const h = host(); await h.enable(2);
  // Concurrency: keep the nolimit menu open, then a second menu must be rejected.
  let release!: (value?: string) => void;
  h.select(() => new Promise<string | undefined>((resolve) => { release = resolve; }));
  const pending = h.command('nolimit #1');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await h.command('nopause #1');
  assert.ok(h.notices.some((notice) => notice.includes('菜单已打开')), h.notices.join(' | '));
  release(undefined);
  await pending;
  assert.equal(h.controller.snapshot().goals[0]!.nolimit, undefined);
  // Epoch: a menu that resolves after a branch restore cannot write into the new state.
  h.select(async (_title, options) => { await h.fire('session_tree'); return options[1]; });
  await h.command('nolimit #1');
  assert.equal(h.controller.snapshot().goals[0]!.nolimit, undefined);
  assert.equal(h.controller.snapshot().run.paused, true);
  await h.fire('session_shutdown');
});

test('the model cannot set nolimit or use enable to reset/switch a user-owned choice', async () => {
  const h = host();
  await h.call({ action: 'create', title: 'A', maxTurns: 2 });
  await h.call({ action: 'create', title: 'B' });
  await h.fire('input', { source: 'rpc', text: '启用 A' });
  await h.call({ action: 'enable', id: 1 });
  h.controller.reserveWake(h.ctx);
  assert.equal((await h.call({ action: 'update', nolimit: true })).isError, true);
  assert.equal((await h.call({ action: 'nolimit', id: 1 })).isError, true);
  assert.equal((await h.call({ action: 'enable', id: 2 })).isError, true, 'the model cannot switch goals to refill the shared budget');
  assert.equal(h.controller.snapshot().goals[0]!.nolimit, undefined);
  await h.fire('session_shutdown');
});

test('unlimited Goals still obey the regular no-progress pause and a failed compaction', async () => {
  const h = host(); await h.enable(2);
  h.select(async (_title, options) => options[1]);
  await h.command('nolimit #1');
  const startTurn = async (messages: any[]) => { await h.fire('turn_start'); await h.fire('context', { messages }); };
  for (let round = 0; round < 12; round++) {
    const next = await h.fire('agent_before_settle', { outcome: 'completed', entries: [], continue: false });
    if (next?.continue) await startTurn(next.entries.map((entry: any) => ({ role: 'custom', ...entry })));
  }
  assert.equal(h.controller.snapshot().run.paused, true);
  assert.match(h.controller.snapshot().run.reason!, /无新进展/);
  await h.fire('session_shutdown');

  const failed = host(); await failed.enable(2);
  failed.select(async (_title, options) => options[1]);
  await failed.command('nolimit #1');
  await failed.fire('session_before_compact', { willRetry: false });
  await failed.fire('session_compact_failed', { aborted: false });
  assert.equal(failed.controller.snapshot().run.paused, true);
  assert.match(failed.controller.snapshot().run.reason!, /压缩未完成/);
  await failed.fire('session_shutdown');
});

// ---------------------------------------------------------------------------
// Real offline Pi process: menu writes state without a model request
// ---------------------------------------------------------------------------

test('real Pi: the nolimit menu flips a Goal without starting it and reports ∞', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(undefined, 'goal-nolimit');
  t.after(() => client.close());
  await client.prompt('TEST CALL goal {"action":"create","title":"无限额度","maxTurns":2}');
  const offset = client.records.length;
  const configuring = client.prompt('/goal nolimit #1');
  await client.until(() => client.records.slice(offset).some((event) => event.method === 'select'));
  const menu = client.records.slice(offset).find((event) => event.method === 'select')!;
  const options = menu.options as string[];
  assert.equal(options.length, 2);
  assert.match(String(menu.title), /续跑轮数/);
  assert.ok(options.some((option) => option.includes('不限')));
  client.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: menu.id, value: options[1] })}\n`);
  await configuring;
  assert.equal(client.records.slice(offset).filter((event) => event.type === 'agent_start').length, 0, 'a passive menu starts no model request');
  const saved = (await client.entries() as any[]).findLast((entry) => entry.customType === GOAL_TYPE).data;
  assert.equal(saved.goals[0].nolimit, true);
  assert.equal(saved.goals[0].maxTurns, 2);
  assert.equal(saved.run.used, 0);
  assert.equal(saved.run.paused, true);
  await client.prompt('/goal list');
  assert.ok(client.records.some((record) => record.method === 'notify' && String(record.message).includes('∞')), 'the Goal list shows the unlimited allowance');
});
