import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkflow } from '../src/workflow/index.ts';
import { restorePlanState } from '../src/plan/state.ts';
import { registerTodos } from '../src/todos/register.ts';
import { registerPlan } from '../src/plan/register.ts';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { emptyState, applyTodo, STATE_TYPE } from '../src/todos/state.ts';

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text, style: (text: string) => text, colors: {}, appearance: 'dark' };
function harness(branch: any[] = []) {
  const tools = new Map(), commands = new Map(), events = new Map<string, Function[]>();
  const pi: any = new Proxy({
    on(name: string, fn: Function) { events.set(name, [...events.get(name) ?? [], fn]); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    appendEntry(customType: string, data: unknown) { branch.push({ type: 'custom', customType, data: structuredClone(data) }); },
    getAllTools: () => [{ name: 'web_search' }, { name: 'other_search' }],
  }, { get(target: any, key: string) { return target[key] ?? (() => undefined); } });
  const ctx: any = {
    mode: 'rpc', cwd: tmpdir(), hasUI: true, isIdle: () => true,
    sessionManager: { getBranch: () => branch, getSessionFile: () => undefined },
    ui: { theme, setWidget() {}, notify() {}, select: async () => undefined,
      custom() { throw new Error('Menus must use native Pi dialogs'); },
    },
  };
  const emit = async (name: string) => { const event = {}; for (const fn of events.get(name) ?? []) await fn(event, ctx); };
  return { pi, ctx, tools, commands, branch, emit };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('Todo-only writes preserve the unselected legacy Plan domain', async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tmpdir(), 'fixture-nonexistent-agent-directory');
  try {
    const h = harness([{ type: 'custom', customType: STATE_TYPE, data: { ...emptyState(), plan: true, planTools: ['web_search'] } }]);
    const workflow = createWorkflow(h.pi); await workflow.attach('todos', h.pi); await h.emit('session_start');
    const expected = { version: 1, enabled: true, tools: ['web_search'] };
    assert.deepEqual(restorePlanState(h.branch), expected);
    assert.equal((await h.tools.get('todo').execute('test', { action: 'create', subject: 'unrelated Todo edit' }, undefined, undefined, h.ctx)).isError, undefined);
    assert.deepEqual(restorePlanState(h.branch), expected);
    await h.commands.get('todos').handler('hide', h.ctx);
    assert.deepEqual(restorePlanState(h.branch), expected);
    await h.emit('session_shutdown');
  } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
});

test('protected Todo display commands cannot overwrite damaged records', async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tmpdir(), 'fixture-nonexistent-agent-directory');
  try {
    const h = harness([{ type: 'custom', customType: STATE_TYPE, data: { ...emptyState(), tasks: 'damaged', plan: true, planTools: ['web_search'] } }]);
    const workflow = createWorkflow(h.pi); await workflow.attach('todos', h.pi); await h.emit('session_start');
    const original = structuredClone(h.branch);
    for (const command of ['hide', 'show', 'paths', 'flat', 'view list']) await h.commands.get('todos').handler(command, h.ctx);
    assert.deepEqual(h.branch, original, 'only an explicit reset may replace protected Todo data');
    assert.equal((await h.tools.get('todo').execute('protected', { action: 'status' }, undefined, undefined, h.ctx)).details.status.protected, true);
    await h.emit('session_shutdown');
  } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
});

for (const language of ['zh-CN', 'en']) test(`native DAG reader keeps each padded task and its right-aligned status on one body row (${language})`, async () => {
  const previous = process.env.PI_CODING_AGENT_DIR, oldLocale = process.env.LC_ALL, oldCols = process.stdout.columns, oldRows = process.stdout.rows;
  process.env.PI_CODING_AGENT_DIR = join(tmpdir(), 'fixture-nonexistent-agent-directory'); process.env.LC_ALL = language; process.stdout.columns = 80; process.stdout.rows = 42;
  let h: ReturnType<typeof harness> | undefined;
  try {
    let state = emptyState(); for (let i = 0; i < 5; i++) state = applyTodo(state, { action: 'create', subject: `构建任务 ${i}` }).state;
    h = harness([{ type: 'custom', customType: STATE_TYPE, data: state }]); h.ctx.mode = 'tui';
    let body: string[] = [];
    h.ctx.ui.select = async (_title: string, options: string[]) => { body = options.filter(value => value.startsWith('│ ')); return undefined; };
    const workflow = createWorkflow(h.pi); await workflow.attach('todos', h.pi); await h.emit('session_start'); await h.commands.get('dag').handler('', h.ctx);
    const taskRows = body.filter(line => /#\d+/.test(line));
    assert.equal(taskRows.length, 5, 'every task is present');
    for (const line of taskRows) assert.match(stripTerminalSequences(line), language === 'zh-CN' ? /\[主会话\].*\[待执行\]$/u : /\[Main session\].*\[Pending\]$/u, 'the right-hand status stays on its task row');
  } finally {
    if (h) await h.emit('session_shutdown'); process.stdout.columns = oldCols; process.stdout.rows = oldRows;
    if (oldLocale === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = oldLocale;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test('old Todo completion confirmation cannot accept a concurrently changed requirement', async () => {
  const h = harness(); h.ctx.mode = 'tui';
  let state = applyTodo(emptyState(), { action: 'create', subject: 'old verified requirement', description: 'old scope' }).state;
  let confirmResolve: (value: boolean) => void = () => {}; let confirmText = '';
  h.ctx.ui.confirm = (_title: string, text: string) => { confirmText = text; return new Promise<boolean>(resolve => { confirmResolve = resolve; }); };
  const steps = ['old verified requirement', '核验后完成任务', '返回']; let step = 0;
  h.ctx.ui.select = async (_title: string, options: string[]) => { const value = options.find(option => option.includes(steps[Math.min(step, steps.length - 1)]!)); step++; return value; };
  const mutate = (params: any) => { const result = applyTodo(state, params); state = result.state; return result; };
  registerTodos(h.pi, { state: () => state, protected: () => false, mutate, commit: next => { state = next; }, reset() {}, async show() {} });
  const running = h.commands.get('todos').handler('', h.ctx);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), 2000); });
  while (!confirmText) { if (await Promise.race([tick().then(() => false as const), bounded]) === 'timeout') throw new Error(`Menu did not reach confirmation; step=${step}`); }
  h.ctx.ui.select = async () => '返回';
  assert.equal(confirmText, 'old verified requirement');
  mutate({ action: 'update', id: 1, subject: 'new unverified requirement', description: 'new scope' });
  confirmResolve(true); await tick();
  assert.equal(state.tasks[0]!.subject, 'new unverified requirement'); assert.equal(state.tasks[0]!.status, 'pending');
  const settled = await Promise.race([running.then(() => 'done' as const), bounded]); clearTimeout(timer);
  assert.equal(settled, 'done', 'the tasks menu returns after native selection completes');
});

for (const modeChange of [true, false]) test(`stale Plan tool menu preserves ${modeChange ? 'active protection' : 'newer tool choices'}`, async () => {
  const h = harness(); let state = emptyState(); let step = 0;
  h.ctx.ui.select = async (_title: string, labels: string[]) => {
    step++;
    if (step === 1) return labels.find(label => label.startsWith('额外只读工具'));
    if (step === 2) {
      await h.commands.get('plan').handler(modeChange ? 'start' : 'tools other_search', h.ctx);
      return labels.find(label => label.startsWith('web_search'));
    }
    return labels.find(label => label === '返回');
  };
  registerPlan(h.pi, { state: () => state, protected: () => false, commit: next => { state = next; }, assertCanEnter() {}, onEnter() {}, loadConfig: async () => ({ planTools: [] }) as any });
  await h.emit('session_start');
  await h.commands.get('plan').handler('settings', h.ctx);
  assert.equal(state.plan, modeChange); assert.deepEqual(state.planTools, modeChange ? [] : ['other_search']);
});
