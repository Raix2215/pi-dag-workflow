import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Value } from 'typebox/value';
import { registerGoal } from '../src/goal/register.ts';
import { applyGoal, emptyGoalState, goalAutoresearch, goalBudgetSpent, goalModelPause, goalNolimit, GoalParamsSchema, GOAL_TYPE, restoreGoalState, setGoalAutoresearch, setGoalNolimit, setModelPausePolicy, validateGoalState } from '../src/goal/state.ts';
import { GOAL_CHECKPOINT_TYPE, goalCheckpoint, goalRules, goalWakeRules, hasCurrentGoalContract } from '../src/goal/prompt.ts';
import { defaultConfig } from '../src/shared/config.ts';
import { createTranslator } from '../src/shared/i18n.ts';
import { emptyState } from '../src/todos/state.ts';
import { IsolatedClient } from './fixtures/isolated-client.ts';

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
  await h.call({ action: 'create', title: '研究目标', maxTurns: 5 });
  const pages: string[][] = []; let listSeen = 0, detailStep = 0;
  h.select(async (title, options) => {
    if (!title.includes('Goal #')) return listSeen++ === 0 ? options.find((value) => value.includes('研究目标'))! : undefined;
    pages.push(options);
    if (detailStep === 0) { detailStep = 1; return options.find((value) => value.includes('持续研究'))!; }
    if (detailStep === 1) { detailStep = 2; return options.find((value) => value === '下一页')!; }
    detailStep = 3;
    return options.find((value) => value === '返回')!;
  });
  await h.command('');
  assert.equal(goalAutoresearch(h.controller.snapshot().goals[0]!), true, 'one click on the row toggles the mode');
  assert.ok(!pages.some((options) => options.some((value) => value.includes('其他设置'))), 'the old settings chain is gone');
  assert.ok(pages[0]!.some((value) => /持续研究.*关闭/.test(value)), pages[0]!.join(' | '));
  assert.ok(pages[0]!.some((value) => /运行中模型中断.*允许/.test(value)), pages[0]!.join(' | '));
  assert.ok(pages[1]!.some((value) => /持续研究.*开启/.test(value)), 'the original page refreshes in place: ' + pages[1]!.join(' | '));
  assert.ok(pages[1]!.some((value) => /运行中模型中断.*禁止（持续研究）/.test(value)), pages[1]!.join(' | '));
  assert.ok(pages[2]!.some((value) => /续跑轮数上限.*不限（持续研究）/.test(value)), pages[2]!.join(' | '));
  assert.ok(pages[1]!.some((value) => /不可用/.test(value)), 'forced ordinary controls are disabled and explain why');
  assert.ok(h.styles.some((style) => style.text === '开启' && style.fg === 'dim'), 'the status value uses the dim value tone instead of the action text tone');
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

test('autoresearch shortcuts are inert on protected state; restore/Plan/errors/user stop remain protective', async () => {
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
    if (kind === 'error') { s.entries.push({ type: 'message', id: 'failed', message: { role: 'assistant', stopReason: 'error' } }); await s.fire('agent_settled', { aborted: false }); }
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
