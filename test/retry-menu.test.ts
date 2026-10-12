import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerRetry } from '../src/retry/register.ts';
import { registerGoal } from '../src/goal/register.ts';
import { emptyState } from '../src/todos/state.ts';
import { defaultConfig } from '../src/shared/config.ts';
import { createTranslator } from '../src/shared/i18n.ts';

function host(language: 'zh-CN' | 'en' = 'zh-CN', onFailed?: (waiting: boolean) => void) {
  const handlers = new Map<string, Function[]>(); const entries: any[] = [], notices: string[] = [], requests: any[] = [], wakes: any[] = [];
  const timers = new Map<number, { due: number; callback: () => void }>(); let time = 0, serial = 0, command: any, scope = 'normal';
  const answers: any[] = [];
  const ask = async (method: string, title: string, value: unknown) => {
    requests.push({ method, title, value }); const next = answers.shift();
    if (typeof next === 'function') return await next({ method, title, value });
    return next;
  };
  const ctx: any = { hasUI: true, isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getBranch: () => entries, getLeafId: () => String(entries.length) }, ui: { notify: (message: string) => notices.push(message), select: (title: string, choices: string[]) => ask('select', title, choices), input: (title: string, placeholder: string) => ask('input', title, placeholder), editor: (title: string, prefill: string) => ask('editor', title, prefill), confirm: (title: string, message: string) => ask('confirm', title, message) } };
  const pi: any = { on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); }, registerCommand(_name: string, value: any) { command = value; }, appendEntry(type: string, data: unknown) { entries.push({ type: 'custom', customType: type, data: structuredClone(data) }); }, sendUserMessage(text: string) { void command.handler(text.slice('/retry '.length), ctx); }, sendMessage(message: any) { wakes.push(message); } };
  const controller = registerRetry(pi, { msg: createTranslator(language), branch: () => entries as never, scope: () => scope, mode: () => 'normal', protected: () => false, failed: (_ctx, waiting) => onFailed?.(waiting), now: () => time, setTimer(callback, delay) { const id = ++serial; timers.set(id, { due: time + delay, callback }); return id as never; }, clearTimer(id) { timers.delete(id as never); } });
  const fire = async (name: string, event: object = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
  const tick = (ms: number) => { time += ms; for (const [id, timer] of [...timers]) if (timer.due <= time) { timers.delete(id); timer.callback(); } };
  const failure = async () => { entries.push({ type: 'message', id: `error-${++serial}`, message: { role: 'assistant', stopReason: 'error', errorMessage: 'synthetic failure' } }); await fire('agent_settled', { aborted: false }); };
  const reply = (...values: unknown[]) => answers.push(...values);
  return { ctx, controller, entries, notices, requests, wakes, timers, reply, fire, tick, failure, setScope: (next: string) => { scope = next; }, cmd: (value = '') => command.handler(value, ctx), menu: () => command.handler('', ctx) };
}

for (const language of ['zh-CN', 'en'] as const) test(`settings/status return to the menu; only root exit or cancel closes (${language})`, async () => {
  const h = host(language); const zh = language === 'zh-CN';
  const settings = zh ? '重试设置' : 'Retry settings', back = zh ? '返回' : 'Back', status = zh ? '查看状态' : 'Show status', exit = zh ? '退出菜单' : 'Exit menu';
  h.reply(settings, back, status, back, exit); await h.menu();
  assert.equal(h.requests.length, 5); assert.equal(h.entries.length, 0); assert.equal(h.wakes.length, 0);
  assert.ok(h.requests[0].value.includes(exit)); assert.ok(!h.requests[0].value.includes(back));
  assert.deepEqual(h.requests[0].value, h.requests[2].value); assert.deepEqual(h.requests[0].value, h.requests[4].value);
  h.reply(settings, undefined, undefined); await h.menu(); assert.equal(h.requests.length, 8);
});

test('invalid editor text is kept editable, confirmed settings return to root without enabling', async () => {
  const h = host(); h.reply('重试设置', '修改间隔', 'not an interval', '2s,3s', true, '退出菜单'); await h.menu();
  const edits = h.requests.filter((request) => request.method === 'editor');
  assert.equal(edits.length, 2); assert.equal(edits[1].value, 'not an interval'); assert.ok(h.notices.length > 0);
  assert.equal(h.controller.snapshot().intervals, '2s,3s'); assert.equal(h.controller.snapshot().enabled, false);
  assert.equal(h.requests.at(-1).value.includes('重试设置'), true);
});

test('cancelled text or confirmation leaves settings and timer unchanged and returns one level', async () => {
  const h = host(); await h.cmd('when-error 3s count 4'); await h.failure(); h.tick(400); const before = h.controller.snapshot(), writes = h.entries.length;
  h.reply('重试设置', '修改间隔', undefined, '修改次数', '5', false, '返回', '退出菜单'); await h.menu();
  assert.equal(h.entries.length, writes); assert.equal(h.controller.snapshot().nextAt, before.nextAt); assert.equal(h.controller.snapshot().count, 4);
});

test('unchanged settings do not write or restart an existing countdown', async () => {
  const h = host(); await h.cmd('when-error 3s count 4'); await h.failure(); h.tick(400); const before = h.controller.snapshot(), writes = h.entries.length;
  h.reply('重试设置', '修改间隔', '3s', '退出菜单'); await h.menu();
  assert.equal(h.entries.length, writes); assert.equal(h.controller.snapshot().nextAt, before.nextAt);
  assert.equal(h.requests.some((request) => request.method === 'confirm'), false);
});

test('count edits preserve attempts and remaining time; interval edits alone restart the interval', async () => {
  const h = host(); await h.cmd('when-error 1s,5s count 4'); await h.failure(); h.tick(1000); await h.fire('turn_start'); await h.failure(); h.tick(700);
  const nextAt = h.controller.snapshot().nextAt;
  h.reply('重试设置', '修改次数', '5', true, '退出菜单'); await h.menu();
  assert.equal(h.controller.snapshot().attempts, 1); assert.equal(h.controller.snapshot().nextAt, nextAt); assert.equal(h.controller.snapshot().count, 5);
  h.reply('重试设置', '修改间隔', '2s', true, '退出菜单'); await h.menu();
  assert.equal(h.controller.snapshot().attempts, 1); assert.equal(h.controller.snapshot().nextAt, 3700);
});

test('empty count is unlimited while Esc never clears a configured count', async () => {
  const h = host(); await h.cmd('when-error 3s count 4');
  h.reply('重试设置', '修改次数', undefined, '返回', '退出菜单'); await h.menu(); assert.equal(h.controller.snapshot().count, 4);
  h.reply('重试设置', '修改次数', '', true, '退出菜单'); await h.menu(); assert.equal(h.controller.snapshot().count, null);
});

test('toggle operations refresh root and first enabling obtains missing settings', async () => {
  const h = host(); h.reply('开启自动重试', '2s', true, '关闭自动重试', '退出菜单'); await h.menu();
  assert.equal(h.controller.snapshot().enabled, false); assert.equal(h.controller.snapshot().intervals, '2s'); assert.equal(h.wakes.length, 0);
  assert.equal(h.requests.at(-1).value[0], '开启自动重试');
});

test('a stale editor or confirmation cannot overwrite external policy edits', async () => {
  const h = host(); await h.cmd('when-error 1s count 2');
  h.reply('重试设置', '修改间隔', async () => { await h.cmd('when-error 5s count 8'); return '2s'; }, '返回', '退出菜单'); await h.menu();
  assert.equal(h.controller.snapshot().intervals, '5s'); assert.equal(h.controller.snapshot().count, 8);
  assert.equal(h.requests.some((request) => request.method === 'confirm'), false);
});

for (const event of ['session_before_tree', 'session_before_switch', 'session_before_fork', 'session_shutdown']) test(`old confirmation is discarded after ${event}`, async () => {
  const h = host(); h.reply('重试设置', '修改间隔', '2s', async () => { await h.fire(event); return true; }); await h.menu();
  assert.equal(h.controller.snapshot().intervals, undefined); assert.equal(h.controller.snapshot().enabled, false);
  h.reply('退出菜单'); await h.menu(); // Old finally does not leave a stuck menu guard.
});

test('reducing count to spent attempts pauses Goal recovery; raising it permits remaining attempts', async () => {
  const failures: boolean[] = [], h = host('zh-CN', (waiting) => failures.push(waiting));
  await h.cmd('when-error 1s count 4'); await h.failure(); h.tick(1000); await h.fire('turn_start'); await h.failure();
  h.reply('重试设置', '修改次数', '1', true, '退出菜单'); await h.menu();
  assert.equal(h.controller.snapshot().phase, 'exhausted'); assert.equal(h.controller.snapshot().attempts, 1); assert.equal(failures.at(-1), false);
  h.tick(10000); assert.equal(h.wakes.length, 1);
  h.reply('重试设置', '修改次数', '2', true, '退出菜单'); await h.menu();
  assert.equal(h.controller.snapshot().phase, 'waiting'); assert.equal(h.controller.snapshot().attempts, 1);
  h.tick(1000); assert.equal(h.wakes.length, 2);
});

test('editing count without intervals warns and stays in settings; enabling cancellation stays off', async () => {
  const h = host(); h.reply('重试设置', '修改次数', '返回', '开启自动重试', undefined, '退出菜单'); await h.menu();
  assert.equal(h.controller.snapshot().enabled, false); assert.equal(h.controller.snapshot().intervals, undefined); assert.equal(h.entries.length, 0);
  assert.ok(h.notices.some((message) => message.includes('请先设置重试间隔')));
});

test('a pending timer skips without probing command delivery while the root menu is open', async () => {
  const h = host(); await h.cmd('when-error 1s count 2'); await h.failure();
  h.reply(() => { h.tick(1000); assert.equal(h.wakes.length, 0); assert.equal(h.controller.snapshot().attempts, 0); assert.equal(h.controller.snapshot().skipped, 1); return '退出菜单'; }); await h.menu();
  assert.equal(h.wakes.length, 0); h.tick(999); assert.equal(h.wakes.length, 0); h.tick(1); assert.equal(h.wakes.length, 1);
});

test('success during a menu keeps navigation open while resetting the streak', async () => {
  const h = host(); await h.cmd('when-error 1s count 2'); await h.failure();
  h.reply(async () => { await h.fire('turn_end', { outcome: 'completed' }); return '查看状态'; }, '返回', '退出菜单'); await h.menu();
  assert.equal(h.requests.length, 3); assert.equal(h.controller.snapshot().attempts, 0); assert.equal(h.controller.snapshot().phase, 'armed');
});

test('scope changes and external confirmations cannot apply stale settings', async () => {
  const h = host(); await h.cmd('when-error 1s count 2');
  h.reply('重试设置', '修改间隔', '2s', () => { h.setScope('another-goal'); return true; }); await h.menu(); assert.equal(h.controller.snapshot().intervals, '1s');
  h.reply('重试设置', '修改间隔', '2s', async () => { await h.cmd('when-error 5s count 8'); return true; }, '返回', '退出菜单'); await h.menu();
  assert.equal(h.controller.snapshot().intervals, '5s'); assert.equal(h.controller.snapshot().count, 8);
});

test('old menu completion cannot release a new menu guard or erase its owned prompt', async () => {
  const h = host(); let oldReply!: (value: string) => void, newReply!: (value: string) => void;
  h.reply(() => new Promise<string>((resolve) => { oldReply = resolve; })); const old = h.menu();
  await h.fire('session_before_tree'); h.reply(() => new Promise<string>((resolve) => { newReply = resolve; })); const newer = h.menu();
  oldReply('退出菜单'); await old;
  assert.equal(h.controller.isPrompt(h.requests.at(-1).title), true); await h.menu(); assert.ok(h.notices.some((message) => message.includes('重试菜单已打开')));
  newReply('退出菜单'); await newer; assert.equal(h.controller.isPrompt(h.requests.at(-1).title), false);
});

for (const retryFirst of [true, false]) test(`active Goal recognizes owned dialogs but pauses on foreign input (retry first: ${retryFirst})`, async (t) => {
  const events = new Map<string, Function[]>(), commands = new Map<string, any>(), tools = new Map<string, any>(); const entries: any[] = [];
  const pi: any = { on(name: string, fn: Function) { events.set(name, [...events.get(name) ?? [], fn]); }, registerCommand(name: string, command: any) { commands.set(name, command); }, registerTool(tool: any) { tools.set(tool.name, tool); }, appendEntry(type: string, data: unknown) { entries.push({ type: 'custom', customType: type, data }); }, sendMessage() {}, sendUserMessage() {} };
  const ctx: any = { hasUI: true, isIdle: () => false, sessionManager: { getBranch: () => entries }, ui: { notify() {} } };
  const fire = async (name: string, event: any) => { for (const fn of events.get(name) ?? []) await fn(event, ctx); };
  let retry: ReturnType<typeof registerRetry>;
  if (retryFirst) retry = registerRetry(pi, { branch: () => entries as never, scope: () => 'goal', mode: () => 'goal', protected: () => false });
  const goal = registerGoal(pi, { state: emptyState, jobs: () => [], protected: () => false, paint() {}, pauseAgents() {}, resumeAgents() {}, isUserPrompt: (title) => retry?.isPrompt(title) ?? false, loadConfig: async () => defaultConfig() });
  if (!retryFirst) retry = registerRetry(pi, { branch: () => entries as never, scope: () => 'goal', mode: () => 'goal', protected: () => false });
  t.after(() => fire('session_shutdown', {}));
  await tools.get('goal').execute('create', { action: 'create', title: 'Menu scope' }, undefined, undefined, ctx); await fire('input', { source: 'rpc', text: 'enable' });
  await tools.get('goal').execute('enable', { action: 'enable', id: 1 }, undefined, undefined, ctx); assert.equal(goal.snapshot().run.paused, false);
  let step = 0; const replies = ['查看状态', '返回', '退出菜单'];
  ctx.ui.select = async (title: string) => { await fire('ui_prompt_start', { title, kind: 'select' }); assert.equal(goal.snapshot().run.paused, false, 'own dialog never pauses active Goal'); await fire('ui_prompt_end', { title, kind: 'select' }); return replies[step++]; };
  await commands.get('retry').handler('', ctx); assert.equal(goal.snapshot().run.paused, false);
  await fire('ui_prompt_start', { title: 'Foreign question', kind: 'input' }); assert.equal(goal.snapshot().run.paused, true); assert.match(goal.snapshot().run.reason!, /等待用户答复/);
});

test('an explicit off while already off still invalidates a pending enable confirmation', async () => {
  const h = host(); h.reply('开启自动重试', '1s', async () => { await h.cmd('off'); return true; }, '退出菜单'); await h.menu();
  assert.equal(h.controller.snapshot().enabled, false); assert.equal(h.controller.snapshot().intervals, undefined); assert.equal(h.wakes.length, 0);
  assert.ok(h.notices.some((message) => message.includes('未保存过期输入')));
});

test('explicit unchanged configuration cannot be overwritten by an older draft', async () => {
  const h = host(); await h.cmd('when-error 1s count 2');
  h.reply('重试设置', '修改间隔', '2s', async () => { await h.cmd('when-error 1s count 2'); return true; }, '返回', '退出菜单'); await h.menu();
  assert.equal(h.controller.snapshot().intervals, '1s'); assert.equal(h.controller.snapshot().count, 2);
});

test('only owned retry dialogs bypass Goal pause; foreign prompts merely block recovery', async () => {
  const h = host(); await h.cmd('when-error 1s count 2'); await h.failure();
  await h.fire('ui_prompt_start', { title: 'Foreign input' });
  assert.equal(h.controller.isPrompt('Foreign input'), false);
  h.tick(1000); assert.equal(h.wakes.length, 0); assert.equal(h.controller.snapshot().attempts, 0);
  await h.fire('ui_prompt_end', { title: 'Foreign input' });
  h.reply(({ title }: any) => { assert.equal(h.controller.isPrompt(title), true); return '退出菜单'; }); await h.menu();
  assert.equal(h.controller.isPrompt(h.requests.at(-1).title), false);
});
