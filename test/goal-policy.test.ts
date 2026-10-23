import { GOAL_WORK_RULE, GOAL_EXECUTION_RULE } from '../src/goal/domain/prompt.ts';
import { classifyModelError, goalRetryDelay } from '../src/goal/domain/failure.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { registerGoal } from "../src/goal/commands/register.ts";
import { applyGoal, emptyGoalState, setModelPausePolicy, restoreGoalState, validateGoalState, GOAL_TYPE, type GoalParams } from "../src/goal/domain/state.ts";
import { emptyState } from '../src/todos/domain/state.ts';
import { createTranslator } from '../src/shared/i18n.ts';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { recordPanels } from './fixtures/public-host.ts';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Value } from 'typebox/value';
import { goalAutoresearch, goalBudgetSpent, goalModelPause, goalNolimit, GoalParamsSchema, setGoalAutoresearch, setGoalNolimit } from "../src/goal/domain/state.ts";
import { GOAL_CHECKPOINT_TYPE, goalCheckpoint, goalRules, goalWakeRules, hasCurrentGoalContract } from "../src/goal/domain/prompt.ts";
import { defaultConfig } from '../src/shared/config.ts';
import { goalLimitLabel } from "../src/goal/domain/state.ts";
import { focusedGoal, pauseGoal, reserveGoalWake, type GoalState } from "../src/goal/domain/state.ts";

// goal-policy.test.ts
{
function host(language: 'zh-CN' | 'en' = 'zh-CN') {
  const events = new Map<string, Function[]>(); const commands = new Map<string, any>(); const tools = new Map<string, any>();
  const entries: any[] = []; const notices: string[] = []; const wakes: any[] = [];
  let selection: (title: string, options: string[]) => Promise<string | undefined> = async (_title, options) => options[1];
  let workflow = emptyState();
  let activeTools = ['goal', 'read', 'bash', 'ask_user_question'];
  const fire = async (name: string, data: any = {}) => { let result: any; for (const handler of events.get(name) ?? []) result = await handler(data, ctx) ?? result; return result; };
  const ctx: any = { hasUI: true, mode: 'rpc', cwd: '/tmp', isIdle: () => false, sessionManager: { getBranch: () => entries }, ui: { notify: (text: string) => notices.push(text), select: async (title: string, options: string[]) => { await fire('ui_prompt_start', { kind: 'select', title }); return selection(title, options); } } };
  const pi: any = { getActiveTools: () => [...activeTools], setActiveTools: (names: string[]) => { activeTools = [...names]; }, on(name: string, handler: Function) { events.set(name, [...events.get(name) ?? [], handler]); }, registerCommand(name: string, command: any) { commands.set(name, command); }, registerTool(tool: any) { tools.set(tool.name, tool); }, appendEntry(customType: string, data: unknown) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); }, sendMessage(message: any) { wakes.push(message); }, sendUserMessage(message: string) { wakes.push(message); } };
  const controller = registerGoal(pi, { msg: createTranslator(language), state: () => workflow, jobs: () => [], paint() {}, pauseAgents() {}, resumeAgents() {}, protected: () => false });
  const call = async (params: GoalParams | any) => tools.get('goal').execute('policy-test', params, undefined, undefined, ctx);
  const command = async (args: string) => commands.get('goal').handler(args, ctx);
  const enable = async () => { await fire('input', { source: 'rpc', text: 'enable this objective' }); await call({ action: 'enable', id: 1 }); };
  return { controller, ctx, call, command, fire, enable, entries, notices, wakes, activeTools: () => [...activeTools], setActiveTools: (names: string[]) => { activeTools = [...names]; }, select(fn: typeof selection) { selection = fn; }, plan(value: boolean) { workflow = { ...workflow, plan: value }; } };
}

for (const language of ['zh-CN', 'en'] as const) {
  for (const pause of ['interrupt', 'disable', 'restore'] as const) {
    test(`paused current Goal accepts notes without waking or changing its contract (${language}, ${pause})`, async () => {
      const h = host(language);
      try {
        await h.call({ action: 'create', title: 'current objective', description: 'preserve every requirement', maxTurns: 6 });
        await h.enable();
        assert.equal(h.controller.reserveWake(h.ctx), true);
        assert.equal(h.controller.reserveWake(h.ctx), true);
        assert.equal((await h.fire('agent_before_settle', { outcome: 'completed', entries: [], continue: false })).continue, true);
        if (pause === 'interrupt') await h.fire('agent_settled', { aborted: true });
        else if (pause === 'disable') await h.command('disable #1');
        else await h.fire('session_tree');
        const before = h.controller.snapshot();
        assert.equal(before.run.paused, true, 'the real pause/restore boundary paused the current Goal');
        assert.equal(before.run.used, 2, 'there is a nonzero allowance to protect');
        assert.equal(before.run.stalled, 1, 'a real no-progress boundary supplies a nonzero stalled count to protect');
        h.ctx.isIdle = () => true;
        const wakes = h.wakes.length;
        assert.equal((await h.call({ action: 'update', id: 1, progress: 'verified while paused' })).isError, undefined, 'the paused current Goal accepts progress');
        assert.equal((await h.call({ action: 'update', nextStep: 'inspect the remaining boundary' })).isError, undefined, 'the paused current Goal accepts nextStep');
        const expected = { ...before, run: { ...before.run, progress: 'verified while paused', nextStep: 'inspect the remaining boundary' } };
        assert.deepEqual(h.controller.snapshot(), expected, 'only the two notes change; pause, reason, counters and contract stay intact');
        const saved = h.entries.length;
        assert.equal((await h.call({ action: 'update', progress: 'verified while paused', nextStep: 'inspect the remaining boundary' })).isError, undefined);
        assert.equal(h.entries.length, saved, 'duplicate notes are still a no-op');
        const read = await h.call({ action: 'get', id: 1 });
        assert.deepEqual(JSON.parse(read.content[0].text).run, expected.run, 'get exposes the saved notes while paused');
        assert.equal(h.controller.canWake(), false);
        assert.equal(h.controller.reserveWake(h.ctx), false);
        const settled = await h.fire('agent_before_settle', { outcome: 'completed', entries: [], continue: false });
        assert.notEqual(settled?.continue, true, 'a passive paused checkpoint must not request continuation');
        await h.fire('agent_settled', { aborted: false });
        assert.deepEqual(h.controller.snapshot(), expected);
        assert.equal(h.wakes.length, wakes, 'updating notes and settling never request another model turn');
      } finally { await h.fire('session_shutdown'); }
    });
  }
  test(`paused notes remain confined to the current Goal (${language})`, async () => {
    const h = host(language);
    try {
      await h.call({ action: 'create', title: 'first' });
      await h.call({ action: 'create', title: 'second' });
      const neverEnabled = h.controller.snapshot();
      const refused = await h.call({ action: 'update', id: 1, progress: 'before enabling' });
      assert.equal(refused.isError, true, 'a never-enabled goal must not receive shared run notes');
      assert.match(refused.content[0].text, language === 'en' ? /current goal/ : /当前目标/);
      assert.deepEqual(h.controller.snapshot(), neverEnabled);
      await h.command('enable #2');
      await h.command('enable #1');
      await h.command('disable #1');
      const before = h.controller.snapshot(), saved = h.entries.length;
      const other = await h.call({ action: 'update', id: 2, progress: 'not the current run', nextStep: 'wrong objective' });
      assert.equal(other.isError, true);
      assert.deepEqual(h.controller.snapshot(), before, 'a previously enabled but non-current Goal cannot overwrite shared run notes');
      assert.equal(h.entries.length, saved, 'rejected updates do not persist anything');
    } finally { await h.fire('session_shutdown'); }
  });
}

test('paused notes retain Plan, nopause and automatic scope guards', async () => {
  const h = host();
  try {
    await h.call({ action: 'create', title: 'original objective', description: 'original requirements', maxTurns: 6 });
    await h.enable();
    assert.equal(h.controller.reserveWake(h.ctx), true);
    await h.command('nopause #1 on');
    await h.command('disable #1');
    const before = h.controller.snapshot();
    h.plan(true);
    assert.equal((await h.call({ action: 'update', progress: 'blocked in Plan' })).isError, true);
    h.plan(false);
    assert.equal((await h.call({ action: 'update', nextStep: '' })).isError, true, 'nopause still rejects empty nextStep');
    assert.equal((await h.call({ action: 'update', description: 'smaller scope', maxTurns: 200 })).isError, true, 'automatic notes cannot change the original scope or allowance');
    assert.deepEqual(h.controller.snapshot(), before);
    assert.equal((await h.call({ action: 'update', progress: 'verified evidence', nextStep: 'bounded next action' })).isError, undefined);
    assert.deepEqual(h.controller.snapshot(), { ...before, run: { ...before.run, progress: 'verified evidence', nextStep: 'bounded next action' } });
  } finally { await h.fire('session_shutdown'); }
});

test('nopause is the only policy command; policy is not kept as an alias and needs no menu', async () => {
  const h = host(); await h.call({ action: 'create', title: 'first' });
  let menus = 0;
  h.select(async (_title, options) => { menus++; return options[1]; });
  const before = h.controller.snapshot();
  await h.command('policy #1');
  assert.equal(menus, 0);
  assert.deepEqual(h.controller.snapshot(), before);
  await h.command('nopause #1');
  assert.equal(menus, 0, 'the shortcut toggles without a GUI');
  assert.equal(h.controller.snapshot().goals[0]!.modelPause, 'deny');
  await h.command('nopause #1 on');
  assert.equal(h.controller.snapshot().goals[0]!.modelPause, 'deny', 'explicit on is idempotent');
  await h.command('nopause #1 off');
  assert.equal(h.controller.snapshot().goals[0]!.modelPause, 'allow');
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
  test(`policy shortcut is passive and model stop attempts are rejected atomically (${language})`, async () => {
    const h = host(language);
    await h.call({ action: 'create', title: 'bounded objective', maxTurns: 6 });
    await h.enable(); h.controller.reserveWake(h.ctx);
    await h.call({ action: 'update', progress: 'verified progress', nextStep: 'saved action' });
    const before = h.controller.snapshot();
    await h.command('nopause #1');
    const notice = h.notices[0]!;
    assert.match(notice, language === 'en' ? /interruption/ : /模型中断/);
    assert.equal(h.controller.snapshot().run.paused, false, 'the shortcut is not a user-wait pause');
    if (language === 'en') assert.doesNotMatch(notice, /\p{Script=Han}/u);
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

test('nopause writes immediately without a menu and never pauses the run', async () => {
  const h = host(); await h.call({ action: 'create', title: 'first' }); await h.enable();
  const before = h.controller.snapshot(); const entries = h.entries.length;
  h.select(async () => { throw new Error('nopause must not open a GUI'); });
  await h.command('nopause #1');
  assert.equal(h.controller.snapshot().goals[0]!.modelPause, 'deny');
  assert.equal(h.entries.length, entries + 1, 'one atomic state commit');
  assert.deepEqual(h.controller.snapshot().run, before.run, 'the switch never pauses or consumes budget');
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

test('policy is preserved on branch restore and restore keeps the Goal paused', async () => {
  const h = host(); await h.call({ action: 'create', title: 'first' }); await h.enable(); await h.command('nopause #1');
  await h.fire('session_tree'); assert.equal(h.controller.snapshot().goals[0]!.modelPause, 'deny');
  assert.equal(h.controller.snapshot().run.paused, true, 'restore keeps the Goal paused');
  await h.enable();
  assert.equal((await h.call({ action: 'disable' })).isError, true, 'the restored deny still blocks model disable');
  await h.fire('session_shutdown');
});

test('a deny policy does not suppress Plan, budget or compaction failure safety pauses', async () => {
  for (const kind of ['plan', 'budget', 'compaction']) {
    const h = host(); await h.call({ action: 'create', title: 'first', maxTurns: kind === 'budget' ? 1 : 10 }); await h.enable(); await h.command('nopause');
    if (kind === 'plan') { h.controller.pause('entering Plan', h.ctx); h.plan(true); }
    if (kind === 'budget') { h.controller.reserveWake(h.ctx); await h.fire('agent_before_settle', { outcome: 'completed', entries: [], continue: false }); }
    if (kind === 'compaction') { await h.fire('session_before_compact', { willRetry: false }); await h.fire('session_compact_failed', { aborted: false }); }
    assert.equal(h.controller.snapshot().run.paused, true, kind);
    assert.equal(h.controller.snapshot().goals[0]!.modelPause, 'deny');
    await h.fire('session_shutdown');
  }
});

test('nopause hides question tools, blocks nested/reactivated calls, and restores only its own removals', async () => {
  const h = host(); await h.call({ action: 'create', title: 'autonomous work' }); await h.enable(); await h.command('nopause');
  assert.deepEqual(h.activeTools(), ['goal', 'read', 'bash']);
  const blocked = await h.fire('tool_call', { toolName: 'ask_user_question', input: {}, parentToolCallId: 'nested-test' });
  assert.equal(blocked.block, true); assert.match(blocked.reason, /Do not ask the user or stop/);
  h.setActiveTools(['goal', 'bash', 'ask_user_question']); // External activation cannot bypass the guard.
  assert.equal((await h.fire('tool_call', { toolName: 'ask_user_question', input: {} })).block, true);
  await h.command('disable');
  assert.deepEqual(h.activeTools(), ['goal', 'bash', 'ask_user_question'], 'do not reactivate an unrelated tool disabled externally');
  assert.equal(await h.fire('tool_call', { toolName: 'ask_user_question', input: {} }), undefined);
  await h.command('enable');
  assert.deepEqual(h.activeTools(), ['goal', 'bash']);
  await h.fire('turn_end', { outcome: 'aborted' });
  assert.ok(h.activeTools().includes('ask_user_question'), 'a user abort restores normal interaction tools');
  await h.fire('session_shutdown');
});

test('restoring nopause tools preserves their original order relative to unaffected tools', async () => {
  const h = host(); h.setActiveTools(['goal', 'ask_user_question', 'read', 'bash']);
  await h.call({ action: 'create', title: 'ordered tools' }); await h.enable(); await h.command('nopause');
  assert.deepEqual(h.activeTools(), ['goal', 'read', 'bash']);
  await h.command('disable');
  assert.deepEqual(h.activeTools(), ['goal', 'ask_user_question', 'read', 'bash']);
  await h.fire('session_shutdown');
});

test('nopause replans and keeps executing past the no-progress threshold until its finite allowance ends', async () => {
  const h = host(); await h.call({ action: 'create', title: 'persistent work', maxTurns: 12 }); await h.enable(); await h.command('nopause');
  for (let index = 0; index < 12; index++) {
    const next = await h.fire('agent_before_settle', { outcome: 'completed', entries: [], continue: false });
    assert.equal(next?.continue, true);
    assert.match(next.entries.at(-1).content, /no user questions/);
    if (index >= 8) assert.match(next.entries.at(-1).content, /execute a different feasible approach now/);
    await h.fire('turn_start'); await h.fire('context', { messages: next.entries });
    assert.equal(h.controller.snapshot().run.paused, false);
  }
  await h.fire('agent_before_settle', { outcome: 'completed', entries: [], continue: false });
  assert.equal(h.controller.snapshot().run.paused, true);
  assert.match(h.controller.snapshot().run.reason!, /上限/);
  await h.fire('session_shutdown');
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
  await client.prompt('/goal nopause #1 on');
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
    await client.prompt('/goal nopause #1 on');
    assert.equal(client.records.slice(offset).filter((event) => event.type === 'agent_start').length, 0);
    const notice = client.records.slice(offset).find((event) => event.method === 'notify' && String(event.message).includes(language === 'en' ? 'Block model interruption' : '禁止模型中断'));
    assert.ok(notice, 'the shortcut reports the saved policy');
    if (language === 'en') assert.doesNotMatch(String(notice!.message), /\p{Script=Han}/u);
    const saved = (await client.entries() as any[]).findLast((entry) => entry.customType === GOAL_TYPE).data;
    assert.equal(saved.goals[0].modelPause, 'deny'); assert.equal(saved.run.used, 0); assert.equal(saved.run.paused, true);
    const records = await client.prompt('TEST CALL goal {"action":"delete","id":1}');
    const failed = records.find((event) => event.type === 'tool_execution_end' && event.toolName === 'goal')!;
    assert.equal(failed.isError, true);
    await client.prompt('/goal delete #1');
    assert.equal((await client.entries() as any[]).findLast((entry) => entry.customType === GOAL_TYPE).data.goals[0].status, 'deleted');
  });
}
}

// goal-autonomy.test.ts
{
const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
const probes = fileURLToPath(new URL('./fixtures/goal-question-tools.ts', import.meta.url));

test('real Pi: configurable nopause bans direct and nested question tools; a user stop restores interaction', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-dag-autonomy-'));
  await mkdir(join(root, 'agent', 'pi-dag-workflow'), { recursive: true });
  await writeFile(join(root, 'agent', 'pi-dag-workflow', 'pi-dag-workflow-config.json'), JSON.stringify({ goalNoPauseTools: [' ask_user_question ', 'test_custom_question'] }));
  const client = await IsolatedClient.start(root, 'autonomy', [probes], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  await client.prompt('TEST CALL goal {"action":"create","title":"空闲续跑测试","maxTurns":6}');
  await client.prompt('/goal nopause #1 on');
  await client.prompt('/goal enable #1');
  await client.until(() => client.records.filter((record) => record.type === 'agent_settled').length >= 2);
  const list = await client.prompt('/test-question-tools');
  const active = JSON.parse(String(list.find((record) => record.method === 'notify')!.message)) as string[];
  assert.ok(!active.includes('ask_user_question'));
  assert.ok(active.includes('goal'));
  for (const name of ['ask_user_question', 'test_nested_question']) {
    const result = await client.prompt(`TEST CALL ${name} {}`);
    const end = result.find((record) => record.type === 'tool_execution_end' && record.toolName === name)!;
    assert.equal(end.isError, true, `${name} cannot ask or execute its question body`);
  }
  await assert.rejects(readFile(join(root, 'question-executed.txt')), { code: 'ENOENT' });
  const state = (await client.entries() as any[]).findLast((entry) => entry.customType === GOAL_TYPE).data;
  assert.equal(state.run.paused, false);
  assert.equal(state.goals[0].modelPause, 'deny');
  await client.prompt('/goal disable #1');
  const restored = await client.prompt('/test-question-tools');
  assert.ok(JSON.parse(String(restored.find((record) => record.method === 'notify')!.message)).includes('ask_user_question'));
  await client.prompt('TEST CALL ask_user_question {}');
  await client.prompt('TEST CALL test_nested_question {}');
  assert.equal(await readFile(join(root, 'question-executed.txt'), 'utf8'), 'ask_user_question\ntest_custom_question\n');
});
}

// goal-autoresearch.test.ts
{
const initial = () => applyGoal(emptyGoalState(), { action: 'create', title: 'Improve within scope', description: 'ORIGINAL-SCOPE; preserve user files', maxTurns: 2 }).state;

test('autoresearch is user-owned, defaults off, and overlays controls without editing run or raw settings', () => {
  let state = initial(); assert.equal(goalAutoresearch(state.goals[0]!), false);
  state = applyGoal(state, { action: 'enable', id: 1 }).state; const run = state.run;
  state = setGoalAutoresearch(state, 1, true); assert.equal(state.run, run); assert.equal(goalNolimit(state.goals[0]!), true); assert.equal(goalModelPause(state.goals[0]!), 'deny');
  assert.equal(state.goals[0]!.nolimit, undefined); assert.equal(state.goals[0]!.modelPause, 'allow'); assert.equal(setGoalAutoresearch(state, 1, true), state);
  state = { ...state, run: { ...state.run, used: 17 } }; assert.equal(goalBudgetSpent(state, state.goals[0]!), false);
  assert.deepEqual(restoreGoalState([{ type: 'custom', customType: GOAL_TYPE, data: state }]), state);
  const disabled = setGoalAutoresearch(state, 1, false); assert.equal(disabled.run, state.run); assert.equal(goalBudgetSpent(disabled, disabled.goals[0]!), true); assert.equal(goalModelPause(disabled.goals[0]!), 'allow');
  const changed = setModelPausePolicy(setGoalNolimit(state, 1, true), 1, 'deny'); assert.equal(changed.goals[0]!.nolimit, true, 'effective overlay must not hide a change to the saved control');
  const restored = setGoalAutoresearch(changed, 1, false); assert.equal(goalNolimit(restored.goals[0]!), true); assert.equal(goalModelPause(restored.goals[0]!), 'deny');
  assert.equal(applyGoal(applyGoal(state, { action: 'disable', id: 1 }).state, { action: 'enable', id: 1 }).state.goals[0]!.autoresearch, true);
});

test('autoresearch validates and cannot be chosen via model parameters or on a completed Goal', () => {
  const state = initial(); assert.throws(() => validateGoalState({ ...state, goals: [{ ...state.goals[0]!, autoresearch: 'on' as never }] }), /持续研究/);
  assert.throws(() => setGoalAutoresearch(state, 1, 'on' as never), /持续研究/); assert.throws(() => setGoalAutoresearch(state, 99, true), /未完成/);
  assert.throws(() => setGoalAutoresearch(applyGoal(state, { action: 'complete', id: 1 }).state, 1, true), /未完成/);
  assert.equal(Value.Check(GoalParamsSchema, { action: 'update', autoresearch: true }), false); assert.equal(Value.Check(GoalParamsSchema, { action: 'autoresearch' }), false);
  assert.throws(() => applyGoal(state, { action: 'update', id: 1, autoresearch: true } as never), /不接受/);
});

test('continuous contract replaces completion rules, keeps full scope, and identifies the effective mode', () => {
  const ordinary = applyGoal(initial(), { action: 'enable', id: 1 }).state, continuous = setGoalAutoresearch(ordinary, 1, true);
  const message = { customType: GOAL_CHECKPOINT_TYPE, content: goalCheckpoint(ordinary) }; assert.equal(hasCurrentGoalContract([message], continuous), false);
  const content = goalCheckpoint(continuous); assert.match(content, /ORIGINAL-SCOPE/); assert.match(content, /"autoresearch":true/); assert.match(content, /"modelPause":"deny"/); assert.match(content, /"nolimit":true/);
  assert.doesNotMatch(goalRules(continuous), /before goal complete|Only verified completion ends/); assert.match(goalRules(continuous), /Never complete/); assert.match(goalRules(continuous), /No automatic Git/);
  assert.match(goalWakeRules(continuous, 8), /No Goal completion/); assert.match(goalWakeRules({ ...continuous, run: { ...continuous.run, stalled: 9 } }, 8), /different feasible approach/);
  assert.equal(hasCurrentGoalContract([{ ...message, content }], { ...continuous, run: { ...continuous.run, used: 100, progress: 'Verified milestone' } }), true);
  assert.equal(hasCurrentGoalContract([{ ...message, content }], ordinary), false);
});

function host(language: 'zh-CN' | 'en' = 'zh-CN', tui = false) {
  const events = new Map<string, Function[]>(), commands = new Map<string, any>(); let tool: any, selection: (title: string, options: string[]) => Promise<string | undefined> = async (_title, options) => options[1];
  const entries: any[] = [], notices: string[] = [], wakes: any[] = [], styles: { text: string; fg: string; bold: boolean }[] = []; let workflow = emptyState(), active = ['goal', 'read', 'ask_user_question'], guarded = false;
  const theme = { style: (text: string, options: { fg: string; bold: boolean }) => { styles.push({ text, ...options }); return text; } };
  const ctx: any = { hasUI: true, ...(tui ? { mode: 'tui', ui: { theme } } : {}), isIdle: () => false, sessionManager: { getBranch: () => entries }, ui: { ...(tui ? { theme } : {}), notify: (text: string) => notices.push(text), select: async (title: string, options: string[]) => { await fire('ui_prompt_start', { title, kind: 'select' }); return selection(title, options); } } };
  const pi: any = { on(name: string, fn: Function) { events.set(name, [...events.get(name) ?? [], fn]); }, registerCommand(name: string, value: any) { commands.set(name, value); }, registerTool(value: any) { tool = value; }, appendEntry(customType: string, data: unknown) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); }, getActiveTools: () => [...active], setActiveTools: (names: string[]) => { active = names; }, sendMessage(message: any) { wakes.push(message); }, sendUserMessage(message: string) { wakes.push(message); } };
  const controller = registerGoal(pi, { msg: createTranslator(language), state: () => workflow, jobs: () => [], paint() {}, protected: () => guarded, pauseAgents() {}, resumeAgents() {}, loadConfig: async () => defaultConfig() });
  const fire = async (name: string, event: any = {}) => { let result: any; for (const fn of events.get(name) ?? []) { const next = await fn(event, ctx); if (next) { result = { ...result, ...next }; if (next.entries) event.entries = next.entries; } } return result; };
  return { ctx, controller, fire, entries, notices, wakes, styles, active: () => active, select(fn: typeof selection) { selection = fn; }, protect(value: boolean) { guarded = value; }, call: (params: any) => tool.execute('autoresearch', params, undefined, undefined, ctx), command: (args: string) => commands.get('goal').handler(args, ctx), plan() { workflow = { ...workflow, plan: true }; controller.pause('Plan', ctx); } };
}

test('Goal control shortcuts reject duplicate ids before changing either target', async (t) => {
  const h = host(); t.after(() => h.fire('session_shutdown'));
  await h.call({ action: 'create', title: 'First' }); await h.call({ action: 'create', title: 'Second' });
  for (const action of ['nopause', 'nolimit', 'autoresearch']) {
    const before = h.controller.snapshot(); const count = h.notices.length;
    await h.command(`${action} #1 #2`);
    assert.deepEqual(h.controller.snapshot(), before, action);
    assert.ok(h.notices.slice(count).some((message) => message.includes('编号')), 'duplicate ids must report usage');
  }
});

test('Goal root page toggles autoresearch in place and marks forced controls without a submenu', async (t) => {
  const h = host('zh-CN', true); t.after(() => h.fire('session_shutdown'));
  const oldColumns = process.stdout.columns; process.stdout.columns = 120; t.after(() => { process.stdout.columns = oldColumns; });
  await h.call({ action: 'create', title: '研究目标', maxTurns: 5 });
  const panels = recordPanels(h.ctx), pages: string[][] = [], opening = h.command('');
  pages.push(panels.body());
  const rootFrame = panels.frame(), separators = rootFrame.flatMap((line, index) => /^─+$/.test(line) ? [index] : []), upper = rootFrame.slice(separators[0]! + 1, separators[1]!).map(line => line.trimEnd());
  assert.equal(upper.filter(line => /目标状态|轮次进度|异常重试/.test(line)).length, 2, 'the three information fields occupy exactly two band rows');
  // Band rows are ordinary readonly rows: dotted leader, bracketed value, aligned with the entity rows.
  assert.match(upper[0]!, /目标状态\s+\.+\s+\[(活动|暂停)\]/); assert.match(upper[1]!, /轮次进度 · 异常重试\s+\.+\s+\[0\/5\] \[0\/5\]/);
  assert.doesNotMatch(upper.slice(2).join('\n'), /目标状态|轮次进度|异常重试/, 'the entity list contains no readonly status rows');
  const source = readFileSync(new URL('../src/goal/commands/register.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /id: '(?:status|autoresearch|nopause)'[^\n]*kind: 'readonly'/, 'no readonly row reuses a settings id');
  await panels.select('研究目标'); await panels.select('运行设置'); await panels.focus('持续研究');
  await panels.press('\r');
  // Reset clears records only after a second Enter, and its hint describes the reset, not the turn cap.
  await panels.focus('重置 Goal 记录');
  assert.match(panels.frame().join('\n'), /清除全部 Goal 记录/);
  assert.doesNotMatch(panels.frame().join('\n'), /轮数上限/);
  await panels.press('\r');
  assert.match(panels.frame().join('\n'), /再次 Enter 重置/);
  assert.equal(h.controller.snapshot().goals.length, 1, 'arming never clears records');
  await panels.press('x');
  assert.equal(goalAutoresearch(h.controller.snapshot().goals[0]!), true, 'one click on the row toggles the mode');
  // The refreshed page keeps the toggle state and the forced-control reasons (scroll to each row).

  await panels.focus('持续研究'); assert.match(panels.frame().join('\n'), /持续研究.*开启/);
  pages.push(panels.body());
  assert.ok(!pages.some((options) => options.some((value) => value.includes('其他设置'))), 'the old settings chain is gone');
  await panels.press('\x1b'); await panels.press('\x1b'); await panels.press('\x1b'); await opening;
  assert.ok(h.styles.some((style) => style.text === '开启' && style.fg === 'accent'), 'enabled states use accent');
  assert.ok(h.styles.some((style) => style.text === '关闭' && style.fg === 'dim'), 'disabled states stay dim');
  // A fresh menu: arming keeps the record, and the second Enter really clears it.
  const clearing = h.command('');
  await panels.wait(() => panels.live() === 1);
  await panels.focus('重置 Goal 记录');
  await panels.press('\r');
  assert.match(panels.frame().join('\n'), /再次 Enter 重置/);
  assert.equal(h.controller.snapshot().goals.length, 1, 'arming never clears records');
  await panels.press('\r');
  await panels.wait(() => h.controller.snapshot().goals.length === 0);
  assert.equal(h.controller.snapshot().goals.length, 0, 'the second Enter clears the Goal records');
  await panels.press('\x1b'); await clearing;
});

// ticket66: only the focused, unfinished goal is "current", and a paused focus is not reported as active.
test('ticket66 the goal list names one current goal and shows a paused focus as paused', async (t) => {
  const h = host('zh-CN', true); t.after(() => h.fire('session_shutdown'));
  const oldColumns = process.stdout.columns; process.stdout.columns = 120; t.after(() => { process.stdout.columns = oldColumns; });
  await h.call({ action: 'create', title: '第一目标', maxTurns: 5 });
  await h.call({ action: 'create', title: '第二目标', maxTurns: 5 });
  // Focusing one goal is what makes it the current one; the other stays a plain goal.
  // Enabling is the user's decision: the model path refuses it, the command does not.
  await h.command('enable #1');
  assert.equal(h.controller.snapshot().focusId, 1, 'goal #1 is the focused one');
  const panels = recordPanels(h.ctx), opening = h.command('');
  await panels.wait(() => panels.live() === 1);
  const frame = () => panels.frame().join('\n');
  assert.equal((frame().match(/当前目标/g) ?? []).length, 1, `exactly one row is called the current goal:\n${frame()}`);
  assert.match(frame(), /当前目标[^\n]*#1 第一目标/, 'the focused goal is the current one');
  assert.match(frame(), /目标 \.\.\.[^\n]*#2 第二目标/, 'the other goal is a plain goal');
  assert.doesNotMatch(frame(), /当前目标[^\n]*#2/, 'the unfocused goal is never called current');
  // Pausing the focus: the status line says paused, never active.
  await h.command('disable #1');
  assert.equal(h.controller.snapshot().run.paused, true, 'the run is paused');
  await panels.press('\x1b'); await panels.wait(() => panels.live() === 0);
  const pausedMenu = h.command('');
  await panels.wait(() => panels.live() === 1);
  const paused = panels.frame().join('\n');
  assert.match(paused, /目标状态\s+\.+\s+\[暂停\]/, `a paused focus is reported as paused:\n${paused}`);
  assert.doesNotMatch(paused, /目标状态\s+\.+\s+\[活动\]/, 'and never as active');
  await panels.press('\x1b'); await pausedMenu; await opening;
});

test('autoresearch shortcuts need no GUI, repeat idempotently, and never auto-start or reset used', async (t) => {
  const h = host('zh-CN'); t.after(() => h.fire('session_shutdown'));
  await h.call({ action: 'create', title: '研究目标', maxTurns: 2 });
  h.select(async () => { throw new Error('shortcut must not open a GUI'); });
  await h.command('autoresearch #1');
  assert.equal(goalAutoresearch(h.controller.snapshot().goals[0]!), true);
  assert.equal(h.wakes.length, 0, 'the mode switch starts no model request');
  assert.equal(h.controller.snapshot().run.used, 0, 'the mode switch never touches used');
  await h.command('autoresearch #1 on');
  assert.equal(goalAutoresearch(h.controller.snapshot().goals[0]!), true, 'explicit on is idempotent');
  await h.command('autoresearch #1 off');
  assert.equal(goalAutoresearch(h.controller.snapshot().goals[0]!), false);
  await h.command('autoresearch #1 off');
  assert.equal(goalAutoresearch(h.controller.snapshot().goals[0]!), false, 'explicit off is idempotent');
  await h.command('nopause #1 on');
  assert.equal(h.controller.snapshot().goals[0]!.modelPause, 'deny');
  await h.command('nolimit #1 on');
  assert.equal(h.controller.snapshot().goals[0]!.nolimit, true);
  await h.command('autoresearch #1 on');
  await h.fire('input', { source: 'rpc', text: 'enable' }); await h.call({ action: 'enable', id: 1 });
  h.controller.reserveWake(h.ctx); h.controller.reserveWake(h.ctx);
  const used = h.controller.snapshot().run.used;
  await h.command('autoresearch #1 off'); await h.command('autoresearch #1 on');
  assert.equal(h.controller.snapshot().run.used, used, 'mode switches never reset used');
  assert.equal(h.controller.snapshot().run.paused, false);
});

for (const language of ['zh-CN', 'en'] as const) test(`continuous menu is passive, shares the guard, and permits only explicit user closure (${language})`, async (t) => {
  const h = host(language); t.after(() => h.fire('session_shutdown')); await h.call({ action: 'create', title: 'A', maxTurns: 1 }); await h.call({ action: 'create', title: 'B' });
  const before = h.controller.snapshot(); h.select(async (title, options) => { if (language === 'en') assert.doesNotMatch([title, ...options].join(' '), /\p{Script=Han}/u); return options[1]; });
  await h.command('autoresearch #1'); assert.deepEqual(h.controller.snapshot().run, before.run); assert.equal(h.wakes.length, 0); assert.equal(h.active().includes('ask_user_question'), true, 'paused mode does not hide tools');
  await h.fire('input', { source: 'rpc', text: 'enable' }); await h.call({ action: 'enable', id: 1 }); assert.equal(h.active().includes('ask_user_question'), false);
  assert.equal((await h.fire('tool_call', { toolName: 'ask_user_question', parentToolCallId: 'nested' })).block, true);
  for (const params of [{ action: 'complete', id: 1 }, { action: 'disable', id: 1 }, { action: 'delete', id: 1 }, { action: 'update', nextStep: '' }, { action: 'enable', id: 2 }]) {
    await h.fire('input', { source: 'rpc', text: 'ordinary input is not permission to stop or switch' }); const saved = h.controller.snapshot(), count = h.entries.length;
    assert.equal((await h.call(params)).isError, true, JSON.stringify(params)); assert.deepEqual(h.controller.snapshot(), saved); assert.equal(h.entries.length, count);
  }
  for (let round = 0; round < 12; round++) { const result = await h.fire('agent_before_settle', { outcome: 'completed', entries: [], continue: false }); assert.equal(result.continue, true); assert.match(result.entries.at(-1).content, /No Goal completion/); await h.fire('turn_start'); await h.fire('context', { messages: result.entries }); }
  assert.equal(h.controller.snapshot().run.used, 12); assert.equal(h.controller.snapshot().run.paused, false);
  assert.doesNotMatch(h.controller.snapshot().run.nextStep ?? '', /达成时 complete/);
  await h.command('autoresearch #1'); assert.equal(goalAutoresearch(h.controller.snapshot().goals[0]!), false); assert.equal(h.controller.snapshot().run.used, 12); assert.equal(h.active().includes('ask_user_question'), true);
  await h.fire('agent_before_settle', { outcome: 'completed', entries: [], continue: false }); assert.equal(h.controller.snapshot().run.paused, true); assert.match(h.controller.snapshot().run.reason!, /上限|allowance|limit/);
  await h.command('autoresearch #1'); await h.command('complete #1'); assert.equal(h.controller.snapshot().goals[0]!.status, 'completed', 'explicit user completion is allowed');
});

test('autoresearch shortcuts are inert on protected state; restore/Plan/errors/user stop remain protective', async (t) => {
  const h = host(); await h.call({ action: 'create', title: 'A' }); const before = h.controller.snapshot();
  h.protect(true); await h.command('autoresearch #1');
  assert.deepEqual(h.controller.snapshot(), before, 'protected state rejects the shortcut');
  assert.ok(h.notices.some((notice) => /受保护|protected/i.test(notice)), h.notices.join(' | '));
  h.protect(false);
  await h.command('autoresearch #1');
  await h.fire('input', { source: 'rpc', text: 'enable' }); await h.call({ action: 'enable', id: 1 });
  await h.fire('session_tree'); assert.equal(h.controller.snapshot().run.paused, true); assert.equal(h.controller.snapshot().goals[0]!.autoresearch, true);
  await h.fire('input', { source: 'rpc', text: 'enable' }); await h.call({ action: 'enable', id: 1 }); h.plan(); assert.equal(h.controller.canWake(), false);
  await h.fire('session_shutdown');
  for (const kind of ['user-stop', 'compaction', 'error']) {
    const s = host(); await s.call({ action: 'create', title: 'A' }); await s.command('autoresearch #1'); await s.fire('input', { source: 'rpc', text: 'enable' }); await s.call({ action: 'enable', id: 1 });
    if (kind === 'user-stop') await s.fire('agent_settled', { aborted: true });
    if (kind === 'compaction') { await s.fire('session_before_compact', { willRetry: false }); await s.fire('session_compact_failed', {}); }
    if (kind === 'error') {
      t.after(() => s.fire('session_shutdown'));
      t.mock.timers.enable({ apis: ['setTimeout'] }); s.ctx.isIdle = () => true;
      for (let attempt = 0; attempt < 5; attempt++) {
        s.entries.push({ type: 'message', id: `failed-${attempt}`, message: { role: 'assistant', stopReason: 'error', errorMessage: 'provider stream disconnected' } });
        await s.fire('agent_settled', { aborted: false });
        assert.equal(s.controller.snapshot().run.paused, false);
        t.mock.timers.tick(1000 * 2 ** attempt);
        assert.equal(s.controller.snapshot().run.errorRetries, attempt + 1);
        await s.fire('turn_start');
      }
      s.entries.push({ type: 'message', id: 'exhausted', message: { role: 'assistant', stopReason: 'error', errorMessage: 'provider stream disconnected' } });
      await s.fire('agent_settled', { aborted: false });
      assert.match(s.controller.snapshot().run.reason!, /次数已用完/);
    }
    assert.equal(s.controller.snapshot().run.paused, true, kind); assert.equal(s.controller.snapshot().goals[0]!.autoresearch, true); await s.fire('session_shutdown');
  }
});

for (const language of ['zh-CN', 'en'] as const) test(`actual Pi: autoresearch shortcut is passive, reports unlimited mode, and continues past finite budget (${language})`, { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(undefined, 'autoresearch-goal', [], ['--dag-test-context-export'], false, undefined, language); t.after(() => client.close());
  await client.prompt('TEST CALL goal {"action":"create","title":"预算测试","description":"ORIGINAL-SCOPE","maxTurns":1}');
  const mark = client.records.length; await client.prompt('/goal autoresearch #1 on');
  assert.equal(client.records.slice(mark).filter((record) => record.type === 'agent_start').length, 0); await client.prompt('/goal get #1'); assert.ok(client.records.some((record) => record.method === 'notify' && String(record.message).includes('∞')));
  await client.prompt('/goal enable #1'); await client.until(() => client.records.some((record) => record.type === 'entry_appended' && (record.entry as any)?.customType === GOAL_TYPE && (record.entry as any).data.run.used >= 4));
  await client.prompt('/goal disable #1'); await client.send('abort');
  const entries = await client.entries() as any[], saved = entries.findLast((entry) => entry.customType === GOAL_TYPE).data;
  assert.equal(saved.goals[0].autoresearch, true); assert.equal(saved.goals[0].status, 'paused'); assert.equal(saved.run.paused, true); assert.ok(saved.run.used >= 3); assert.equal(saved.goals[0].nolimit, undefined); assert.equal(saved.goals[0].modelPause, 'allow');
  assert.ok(entries.some((entry) => entry.customType === 'dag-test.context-export' && JSON.stringify(entry.data.context.messages).includes('Never complete')));
  assert.equal(client.records.some((record) => record.type === 'extension_error'), false);
});
}

// goal-nolimit.test.ts
{
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
  // Only the next normal admission observes the restored finite cap; metadata is not a wake.
  assert.notEqual((await h.fire('agent_before_settle', { outcome: 'completed', entries: [], continue: false }))?.continue, true);
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
  assert.notEqual((await h.fire('agent_before_settle', { outcome: 'completed', entries: [], continue: false }))?.continue, true);
  await h.fire('session_shutdown');
});

test('nolimit shortcuts are idempotent, guarded, and branch restore keeps the newest state', async () => {
  const h = host(); await h.enable(2);
  await h.command('nolimit #1 on');
  assert.equal(h.controller.snapshot().goals[0]!.nolimit, true);
  await h.command('nolimit #1 on');
  assert.equal(h.controller.snapshot().goals[0]!.nolimit, true, 'repeating on is idempotent');
  await h.command('nolimit #1 off');
  assert.equal(h.controller.snapshot().goals[0]!.nolimit, false);
  await h.command('nolimit #1 off');
  assert.equal(h.controller.snapshot().goals[0]!.nolimit, false, 'repeating off is idempotent');
  await h.command('nolimit #1 maybe');
  assert.ok(h.notices.some((notice) => /on\|off/.test(notice)), h.notices.join(' | '));
  await h.command('nolimit #1 on');
  await h.fire('session_tree');
  assert.equal(h.controller.snapshot().goals[0]!.nolimit, true, 'the user choice is restored from the branch');
  assert.equal(h.controller.snapshot().run.paused, true, 'restore keeps the Goal paused');
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

test('real Pi: the nolimit shortcut flips a Goal without starting it and reports ∞', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(undefined, 'goal-nolimit');
  t.after(() => client.close());
  await client.prompt('TEST CALL goal {"action":"create","title":"无限额度","maxTurns":2}');
  const offset = client.records.length;
  await client.prompt('/goal nolimit #1 on');
  assert.equal(client.records.slice(offset).filter((event) => event.type === 'agent_start').length, 0, 'a passive shortcut starts no model request');
  assert.ok(client.records.slice(offset).some((record) => record.method === 'notify' && String(record.message).includes('不限')), 'the shortcut reports the unlimited allowance');
  const saved = (await client.entries() as any[]).findLast((entry) => entry.customType === GOAL_TYPE).data;
  assert.equal(saved.goals[0].nolimit, true);
  assert.equal(saved.goals[0].maxTurns, 2);
  assert.equal(saved.run.used, 0);
  assert.equal(saved.run.paused, true);
  await client.prompt('/goal get #1');
  assert.ok(client.records.some((record) => record.method === 'notify' && String(record.message).includes('∞')), 'the Goal detail shows the unlimited allowance');
});
}

// goal-scope.test.ts
{
test('automatic model cannot enlarge its allowance or silently switch objectives', async () => {
  const handlers = new Map<string, Function>(); let tool: any;
  const ctx: any = { sessionManager: { getBranch: () => [] }, isIdle: () => false, ui: { notify() {} } };
  const pi: any = { on(event: string, handler: Function) { handlers.set(event, handler); }, registerTool(value: any) { tool = value; }, registerCommand() {}, appendEntry() {}, sendUserMessage() {} };
  const control = registerGoal(pi, { state: emptyState, jobs: () => [], paint() {}, protected: () => false, pauseAgents() {}, resumeAgents() {} });
  const call = (args: any) => tool.execute('id', args, undefined, undefined, ctx);
  await call({ action: 'create', title: 'A', maxTurns: 2 });
  await call({ action: 'create', title: 'B' });
  handlers.get('input')!({ source: 'rpc', text: '启用 A' }, ctx);
  await call({ action: 'enable', id: 1 });
  assert.equal(control.reserveWake(ctx), true);
  assert.equal((await call({ action: 'update', maxTurns: 200 })).isError, true);
  assert.equal((await call({ action: 'enable', id: 2 })).isError, true);
  assert.equal((await call({ action: 'update', progress: '新事实', nextStep: '继续核查' })).isError, undefined);
  assert.equal(control.snapshot().goals[0]!.maxTurns, 2);
  assert.equal(control.snapshot().focusId, 1);
  handlers.get('input')!({ source: 'rpc', text: '我明确要求切换到 B' }, ctx);
  assert.equal((await call({ action: 'enable', id: 2 })).isError, undefined);
  assert.equal(control.snapshot().focusId, 2);
});
}

// goal-vocabulary.test.ts
{
function host() {
  const tools = new Map<string, any>(); const commands = new Map<string, any>();
  const notifications: string[] = []; const wakes: any[] = []; const entries: any[] = [];
  let workflow = emptyState();
  const ctx: any = { cwd: '/tmp', mode: 'rpc', hasUI: true, isIdle: () => true, sessionManager: { getBranch: () => entries }, ui: { notify: (text: string, level: string) => notifications.push(`${level}:${text}`), confirm: async () => true } };
  const pi: any = { on() { return () => {}; }, registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand(name: string, cmd: any) { commands.set(name, cmd); }, appendEntry(customType: string, data: any) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); }, sendMessage(message: any, options: any) { wakes.push({ message, options }); }, sendUserMessage(message: string) { wakes.push({ message, options: { source: 'extension' } }); } };
  const controller = registerGoal(pi, { state: () => workflow, jobs: () => [], paint() {}, protected: () => false, pauseAgents() {}, resumeAgents() {} });
  const call = async (params: GoalParams) => tools.get('goal').execute('test', params, undefined, undefined, ctx);
  const command = (text: string) => commands.get('goal').handler(text, ctx);
  return { controller, call, command, notifications, wakes, entries };
}

const NON_ACTIONS = ['focus', 'switch', 'resume', 'pause', 'on', 'off', 'done', 'del', 'create', 'status'];

test('Goal commands keep no alias layer: unlisted words go to the model as natural language', async () => {
  const h = host();
  for (const word of NON_ACTIONS) {
    h.notifications.length = 0; h.wakes.length = 0;
    await h.command(`${word} #1`);
    assert.equal(h.wakes.length, 1, `${word} is not a command action, so it is forwarded`);
    assert.match(String(h.wakes[0]!.message), /^Manage the current Goal:/);
    assert.equal(h.notifications.length, 0, `${word} must not print a compatibility hint`);
  }
  const original = '保持这段用户中文原样';
  await h.command(original);
  assert.equal(h.wakes.at(-1)!.message, `Manage the current Goal: ${original}`);
});

test('the Goal tool schema exposes one literal per operation', () => {
  for (const action of ['create', 'update', 'list', 'get', 'delete', 'enable', 'disable', 'complete']) {
    assert.equal(Value.Check(GoalParamsSchema, { action, title: 'x' }), true, action);
  }
  // `create` is the tool's own action name; the command word for it is `new`.
  for (const action of NON_ACTIONS.filter((word) => word !== 'create')) assert.equal(Value.Check(GoalParamsSchema, { action }), false, action);
});

test('canonical Goal commands act without aliases', async () => {
  const h = host();
  await h.call({ action: 'create', title: 'A' });
  await h.call({ action: 'create', title: 'B' });
  await h.command('enable #2');
  assert.equal(h.controller.snapshot().focusId, 2);
  await h.command('disable');
  assert.equal(h.controller.snapshot().run.paused, true);
  assert.equal(h.controller.snapshot().run.reason, '已停用');
  await h.command('enable');
  assert.equal(h.controller.snapshot().run.paused, false);
  assert.equal(h.controller.snapshot().focusId, 2, 'omitting the id re-enables the current focus');
  await h.command('complete #2');
  assert.equal(h.controller.snapshot().goals[1]!.status, 'completed');
  assert.equal(h.controller.snapshot().focusId, undefined);
  // The command list is the vocabulary: two ids on a single-id action are rejected.
  for (const text of ['enable #1 #2', 'disable #1 #2']) {
    h.notifications.length = 0; h.wakes.length = 0;
    await h.command(text);
    const notice = h.notifications.at(-1) ?? '';
    assert.ok(notice.startsWith('error:') && notice.includes('此命令只接受一个编号'), `${text}: ${notice}`);
    assert.equal(h.wakes.length, 0, text);
  }
});
}

// goals.test.ts
{
const create = (state: GoalState, title = '目标') => applyGoal(state, { action: 'create', title }).state;
test('goals are independent records; only enable selects one active target', () => {
  let state = create(create(emptyGoalState(), 'A'), 'B');
  assert.equal(focusedGoal(state), undefined);
  assert.equal(state.goals[0]!.maxTurns, 32);
  state = applyGoal(state, { action: 'enable', id: 1 }).state;
  state = applyGoal(state, { action: 'enable', id: 2 }).state;
  assert.equal(focusedGoal(state)!.title, 'B');
  assert.equal(state.goals.filter((goal) => goal.status === 'active').length, 1);
  assert.equal(state.goals[0]!.status, 'paused');
});
test('same active focus cannot refill budget; explicit disable then enable can start a new allowance', () => {
  let state = applyGoal(create(emptyGoalState()), { action: 'enable', id: 1 }).state;
  state = reserveGoalWake(state)!;
  assert.equal(applyGoal(state, { action: 'enable', id: 1 }).state, state);
  assert.equal(state.run.used, 1);
  state = applyGoal(state, { action: 'disable' }).state;
  assert.equal(focusedGoal(state)!.id, 1, 'paused attention stays visible');
  assert.equal(reserveGoalWake(state), undefined);
  state = applyGoal(state, { action: 'enable' }).state;
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
}

// Pure contract construction and identity calculations stay in the controlled policy suite.
{
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
  for (const reason of ['会话恢复', '自动续跑达到 12 轮上限']) {
    const paused = { ...state, run: { ...state.run, paused: true, reason } };
    assert.doesNotMatch(goalCheckpoint(paused), /\p{Script=Han}/u, 'plugin-owned saved reasons have an English model view');
    assert.equal(paused.run.reason, reason, 'the saved reason used by the Chinese UI is unchanged');
  }
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
}
{
const active = () => applyGoal(applyGoal(emptyGoalState(), { action: 'create', title: 'current objective', description: 'FINAL-REQUIREMENT' }).state, { action: 'enable', id: 1 }).state;
const contract = (state: ReturnType<typeof active>) => ({ role: 'custom', customType: GOAL_CHECKPOINT_TYPE, content: goalCheckpoint(state) });

test('contract matching preserves all authority fields but ignores used/progress/nextStep counters', () => {
  const state = active(); const message = contract(state);
  assert.equal(hasCurrentGoalContract([message], state), true);
  assert.equal(hasCurrentGoalContract([message], { ...state, run: { ...state.run, used: 6, progress: 'new evidence', nextStep: 'changed note' } }), true);
  assert.equal(hasCurrentGoalContract([message], applyGoal(state, { action: 'update', description: 'CHANGED-TAIL' }).state), false);
  assert.equal(hasCurrentGoalContract([message], setModelPausePolicy(state, 1, 'deny')), false);
  assert.equal(hasCurrentGoalContract([{ ...message, content: message.content.replace('FINAL-REQUIREMENT', 'cropped') }], state), false);
  assert.equal(hasCurrentGoalContract([{ ...message, content: 'Goal contract (\nmalformed' }], state), false);
});

}

{
const activeNotes = () => applyGoal(applyGoal(emptyGoalState(), { action: 'create', title: 'verify actual work' }).state, { action: 'enable', id: 1 }).state;
test('important notes preserve interior evidence; outer whitespace and duplicate notes are real no-ops', () => {
  let state = activeNotes();
  state = applyGoal(state, { action: 'update', progress: '  Compared "file  name"; 12 checks pass.  ', nextStep: '  inspect remaining failures  ' }).state;
  assert.equal(state.run.progress, 'Compared "file  name"; 12 checks pass.');
  assert.equal(state.run.nextStep, 'inspect remaining failures');
  assert.equal(applyGoal(state, { action: 'update', progress: '\nCompared "file  name"; 12 checks pass.\n', nextStep: '\ninspect remaining failures\n' }).state, state);
  assert.equal(applyGoal(state, { action: 'update', progress: 'A reproducible regression was found.' }).state.run.progress, 'A reproducible regression was found.');
});

test('quota/billing/auth errors take priority over rate-limit and server wording', () => {
  for (const text of ['429 insufficient_quota', '429 usage_limit_reached', 'The usage limit has been reached', 'billing limit exhausted (HTTP 500)', 'insufficient credits', '401 invalid_api_key', 'HTTP 403: permission denied', 'authentication_error', 'model_not_found']) assert.equal(classifyModelError(text), 'permanent', text);
  for (const text of ['429 rate_limit_exceeded', 'HTTP 503 billing service temporarily unavailable', 'HTTP 503 overloaded', 'ECONNRESET', 'stream interrupted', 'timeout', 'fetch failed']) assert.equal(classifyModelError(text), 'transient', text);
  for (const text of ['', 'something unexpected happened', 'context length exceeded']) assert.equal(classifyModelError(text), 'unknown', text);
});

test('recovery backs off exponentially, remains capped, and starts over after a success', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 20].map(goalRetryDelay), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(goalRetryDelay(0), 1000);
});
}
