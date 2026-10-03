import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { registerGoal } from '../src/goal/register.ts';
import { applyGoal, emptyGoalState, setModelPausePolicy, restoreGoalState, validateGoalState, GOAL_TYPE, type GoalParams } from '../src/goal/state.ts';
import { emptyState } from '../src/todos/state.ts';
import { createTranslator } from '../src/shared/i18n.ts';
import { IsolatedClient } from './fixtures/isolated-client.ts';

function host(language: 'zh-CN' | 'en' = 'zh-CN') {
  const events = new Map<string, Function[]>(); const commands = new Map<string, any>(); const tools = new Map<string, any>();
  const entries: any[] = []; const notices: string[] = []; const wakes: any[] = [];
  let selection: (title: string, options: string[]) => Promise<string | undefined> = async (_title, options) => options[1];
  let workflow = emptyState();
  const fire = async (name: string, data: any = {}) => { let result: any; for (const handler of events.get(name) ?? []) result = await handler(data, ctx) ?? result; return result; };
  const ctx: any = { hasUI: true, mode: 'rpc', cwd: '/tmp', isIdle: () => false, sessionManager: { getBranch: () => entries }, ui: { notify: (text: string) => notices.push(text), select: async (title: string, options: string[]) => { await fire('ui_prompt_start', { kind: 'select', title }); return selection(title, options); } } };
  const pi: any = { on(name: string, handler: Function) { events.set(name, [...events.get(name) ?? [], handler]); }, registerCommand(name: string, command: any) { commands.set(name, command); }, registerTool(tool: any) { tools.set(tool.name, tool); }, appendEntry(customType: string, data: unknown) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); }, sendMessage(message: any) { wakes.push(message); }, sendUserMessage(message: string) { wakes.push(message); } };
  const controller = registerGoal(pi, { msg: createTranslator(language), state: () => workflow, jobs: () => [], paint() {}, pauseAgents() {}, resumeAgents() {}, protected: () => false });
  const call = async (params: GoalParams | any) => tools.get('goal').execute('policy-test', params, undefined, undefined, ctx);
  const command = async (args: string) => commands.get('goal').handler(args, ctx);
  const enable = async () => { await fire('input', { source: 'rpc', text: 'enable this objective' }); await call({ action: 'enable', id: 1 }); };
  return { controller, ctx, call, command, fire, enable, entries, notices, wakes, select(fn: typeof selection) { selection = fn; }, plan(value: boolean) { workflow = { ...workflow, plan: value }; } };
}

test('nopause is the only menu command; policy is not kept as an alias', async () => {
  const h = host(); await h.call({ action: 'create', title: 'first' });
  let menus = 0;
  h.select(async (_title, options) => { menus++; return options[1]; });
  const before = h.controller.snapshot();
  await h.command('policy #1');
  assert.equal(menus, 0);
  assert.deepEqual(h.controller.snapshot(), before);
  await h.command('nopause #1');
  assert.equal(menus, 1);
  assert.equal(h.controller.snapshot().goals[0]!.modelPause, 'deny');
  await h.fire('session_shutdown');
});

test('per-Goal policy survives enable, validates, and never changes run or another Goal', () => {
  let state = applyGoal(emptyGoalState(), { action: 'create', title: 'first' }).state;
  state = applyGoal(state, { action: 'create', title: 'second' }).state;
  state = applyGoal(state, { action: 'enable', id: 1 }).state;
  const run = state.run;
  const changed = setModelPausePolicy(state, 1, 'deny');
  assert.equal(changed.run, run); assert.equal(changed.focusId, 1);
  assert.equal(changed.goals[0]!.modelPause, 'deny'); assert.equal(changed.goals[1]!.modelPause, 'allow');
  assert.equal(setModelPausePolicy(changed, 1, 'deny'), changed);
  const disabled = applyGoal(changed, { action: 'disable', id: 1 }).state;
  assert.equal(applyGoal(disabled, { action: 'enable', id: 1 }).state.goals[0]!.modelPause, 'deny');
  assert.deepEqual(restoreGoalState([{ type: 'custom', customType: GOAL_TYPE, data: changed }]), changed);
  assert.throws(() => validateGoalState({ ...changed, goals: [{ ...changed.goals[0]!, modelPause: 'invalid' as any }] }), /策略/);
  assert.throws(() => setModelPausePolicy(changed, 99, 'deny'), /找不到/);
});

for (const language of ['zh-CN', 'en'] as const) {
  test(`policy menu is passive and model stop attempts are rejected atomically (${language})`, async () => {
    const h = host(language);
    await h.call({ action: 'create', title: 'bounded objective', maxTurns: 6 });
    await h.enable(); h.controller.reserveWake(h.ctx);
    await h.call({ action: 'update', progress: 'verified progress', nextStep: 'saved action' });
    const before = h.controller.snapshot();
    h.select(async (title, options) => {
      assert.match(title, /nopause/);
      if (language === 'en') { assert.doesNotMatch(title, /\p{Script=Han}/u); options.forEach((item) => assert.doesNotMatch(item, /\p{Script=Han}/u)); }
      assert.equal(h.controller.snapshot().run.paused, false, 'its own menu is not a user-wait pause');
      return options[1];
    });
    await h.command('nopause #1');
    const after = h.controller.snapshot();
    assert.equal(after.goals[0]!.modelPause, 'deny'); assert.deepEqual(after.run, before.run); assert.equal(after.focusId, before.focusId);
    assert.equal(h.wakes.length, 0); assert.equal(h.notices.length, 1);
    for (const params of [{ action: 'disable' }, { action: 'delete' }, { action: 'update', nextStep: '' }, { action: 'update', nextStep: '  ' }]) {
      const saved = h.controller.snapshot(); const count = h.entries.length;
      const result = await h.call(params);
      assert.equal(result.isError, true); assert.match(result.content[0].text, /\/goal disable/);
      assert.deepEqual(h.controller.snapshot(), saved); assert.equal(h.entries.length, count);
    }
    await h.fire('input', { source: 'rpc', text: 'ordinary new request' });
    assert.equal((await h.call({ action: 'disable' })).isError, true, 'recent user input does not let the model silently bypass the selected policy');
    assert.equal((await h.call({ action: 'update', modelPause: 'allow' })).isError, true, 'model cannot change a user-owned setting');
    assert.equal((await h.call({ action: 'nopause', id: 1 })).isError, true);
    assert.equal((await h.call({ action: 'update', nextStep: 'permitted action' })).isError, undefined);
    await h.command('disable #1'); assert.equal(h.controller.snapshot().run.paused, true);
    await h.command('enable #1'); assert.equal(h.controller.snapshot().goals[0]!.modelPause, 'deny');
    assert.equal((await h.call({ action: 'complete', id: 1 })).isError, undefined, 'verified completion stays available');
    await h.fire('session_shutdown');
  });
}

test('cancelled policy menu keeps state untouched; a real user dialog still pauses even during that menu', async () => {
  const h = host(); await h.call({ action: 'create', title: 'first' }); await h.enable();
  const before = h.controller.snapshot(); const entries = h.entries.length;
  h.select(async () => undefined); await h.command('nopause');
  assert.deepEqual(h.controller.snapshot(), before); assert.equal(h.entries.length, entries);
  h.select(async (_title, options) => { await h.fire('ui_prompt_start', { kind: 'select', title: 'a different model question' }); return options[1]; });
  await h.command('nopause');
  assert.equal(h.controller.snapshot().run.paused, true);
  assert.equal(h.controller.snapshot().goals[0]!.modelPause, 'deny');
  await h.fire('session_shutdown');
});

test('allow remains the default and can be selected again; manual deletion always remains available', async () => {
  const h = host(); await h.call({ action: 'create', title: 'first' }); await h.enable();
  assert.equal((await h.call({ action: 'disable' })).isError, undefined);
  await h.enable(); await h.command('nopause');
  assert.equal((await h.call({ action: 'disable' })).isError, true);
  h.select(async (_title, options) => options[1]); await h.command('nopause');
  assert.equal(h.controller.snapshot().goals[0]!.modelPause, 'allow');
  assert.equal((await h.call({ action: 'disable' })).isError, undefined);
  await h.command('delete #1'); assert.equal(h.controller.snapshot().goals[0]!.status, 'deleted');
  await h.fire('session_shutdown');
});

test('policy is preserved on branch restore, and a stale menu cannot write into the restored branch', async () => {
  const h = host(); await h.call({ action: 'create', title: 'first' }); await h.enable(); await h.command('nopause');
  await h.fire('session_tree'); assert.equal(h.controller.snapshot().goals[0]!.modelPause, 'deny');
  await h.enable();
  const saved = h.controller.snapshot();
  h.select(async (_title, options) => { await h.fire('session_tree'); return options[1]; });
  await h.command('nopause');
  assert.equal(h.controller.snapshot().goals[0]!.modelPause, saved.goals[0]!.modelPause);
  assert.equal(h.controller.snapshot().run.paused, true);
  await h.fire('session_shutdown');
});

test('a deny policy does not suppress Plan, budget, compaction failure or no-progress safety pauses', async () => {
  for (const kind of ['plan', 'budget', 'compaction', 'stall']) {
    const h = host(); await h.call({ action: 'create', title: 'first', maxTurns: kind === 'budget' ? 1 : 10 }); await h.enable(); await h.command('nopause');
    if (kind === 'plan') { h.controller.pause('entering Plan', h.ctx); h.plan(true); }
    if (kind === 'budget') { h.controller.reserveWake(h.ctx); await h.fire('agent_before_settle', { outcome: 'completed', entries: [], continue: false }); }
    if (kind === 'compaction') { await h.fire('session_before_compact', { willRetry: false }); await h.fire('session_compact_failed', { aborted: false }); }
    if (kind === 'stall') for (let index = 0; index < 4 && !h.controller.snapshot().run.paused; index++) {
      const next = await h.fire('agent_before_settle', { outcome: 'completed', entries: [], continue: false });
      if (next?.continue) { await h.fire('turn_start'); await h.fire('context', { messages: next.entries }); }
    }
    assert.equal(h.controller.snapshot().run.paused, true, kind);
    assert.equal(h.controller.snapshot().goals[0]!.modelPause, 'deny');
    await h.fire('session_shutdown');
  }
});

test('real Pi: selecting deny on an active Goal preserves its budget and blocks a later model disable', { timeout: 30000 }, async (t) => {
  const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
  const client = await IsolatedClient.start(undefined, 'active-goal-policy', [], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  await client.prompt('TEST CALL goal {"action":"create","title":"空闲续跑测试","maxTurns":6}');
  await client.prompt('/goal enable #1');
  await client.until(() => client.records.filter((event) => event.type === 'agent_settled').length >= 2);
  const before = (await client.entries() as any[]).findLast((entry) => entry.customType === GOAL_TYPE).data;
  assert.equal(before.run.paused, false); assert.equal(before.run.used, 1);
  const offset = client.records.length;
  const configured = client.prompt('/goal nopause');
  await client.until(() => client.records.slice(offset).some((event) => event.method === 'select'));
  const menu = client.records.slice(offset).find((event) => event.method === 'select')!;
  client.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: menu.id, value: (menu.options as string[])[1] })}\n`);
  await configured;
  const after = (await client.entries() as any[]).findLast((entry) => entry.customType === GOAL_TYPE).data;
  assert.deepEqual(after.run, before.run);
  assert.equal(after.goals[0].modelPause, 'deny');
  assert.equal(client.records.slice(offset).filter((event) => event.type === 'agent_start').length, 0);
  const records = await client.prompt('TEST CALL goal {"action":"disable","id":1}');
  const blocked = records.find((event) => event.type === 'tool_execution_end' && event.toolName === 'goal')!;
  assert.equal(blocked.isError, true);
  const stillActive = (await client.entries() as any[]).findLast((entry) => entry.customType === GOAL_TYPE).data;
  assert.equal(stillActive.run.paused, false); assert.equal(stillActive.run.used, 1);
  await client.prompt('/goal disable #1');
  assert.equal((await client.entries() as any[]).findLast((entry) => entry.customType === GOAL_TYPE).data.run.paused, true);
});

for (const language of ['zh-CN', 'en']) {
  test(`real Pi: user selects a per-Goal deny policy without a model request (${language})`, { timeout: 30000 }, async (t) => {
    const client = await IsolatedClient.start(undefined, 'goal-policy', [], [], false, undefined, language);
    t.after(() => client.close());
    await client.prompt('TEST CALL goal {"action":"create","title":"first objective","maxTurns":6}');
    const offset = client.records.length;
    const configuring = client.prompt('/goal nopause #1');
    await client.until(() => client.records.slice(offset).some((event) => event.method === 'select'));
    const menu = client.records.slice(offset).find((event) => event.method === 'select')!;
    const options = menu.options as string[];
    assert.equal(options.length, 2); assert.match(String(menu.title), /nopause/); if (language === 'en') assert.doesNotMatch(String(menu.title), /\p{Script=Han}/u);
    client.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: menu.id, value: options[1] })}\n`);
    await configuring;
    assert.equal(client.records.slice(offset).filter((event) => event.type === 'agent_start').length, 0);
    const saved = (await client.entries() as any[]).findLast((entry) => entry.customType === GOAL_TYPE).data;
    assert.equal(saved.goals[0].modelPause, 'deny'); assert.equal(saved.run.used, 0); assert.equal(saved.run.paused, true);
    const records = await client.prompt('TEST CALL goal {"action":"delete","id":1}');
    const failed = records.find((event) => event.type === 'tool_execution_end' && event.toolName === 'goal')!;
    assert.equal(failed.isError, true);
    await client.prompt('/goal delete #1');
    assert.equal((await client.entries() as any[]).findLast((entry) => entry.customType === GOAL_TYPE).data.goals[0].status, 'deleted');
  });
}
