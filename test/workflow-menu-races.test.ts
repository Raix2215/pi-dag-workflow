import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkflow } from '../src/workflow/index.ts';
import { restorePlanState } from '../src/plan/state.ts';
import { registerTodos } from '../src/todos/register.ts';
import { registerPlan } from '../src/plan/register.ts';
import { emptyState, applyTodo, STATE_TYPE } from '../src/todos/state.ts';

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text, colors: {}, appearance: 'dark' };
function harness(branch: any[] = []) {
  const tools = new Map(), commands = new Map(), events = new Map<string, Function[]>(), panels: any[] = [];
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
      custom(factory: Function) { return new Promise(resolve => panels.push(factory({ terminal: { rows: 36 }, requestRender() {} }, theme, {}, resolve))); },
    },
  };
  const emit = async (name: string) => { const event = {}; for (const fn of events.get(name) ?? []) await fn(event, ctx); };
  return { pi, ctx, tools, commands, branch, panels, emit };
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

test('old Todo completion confirmation cannot accept a concurrently changed requirement', async () => {
  const h = harness(); h.ctx.mode = 'tui';
  let state = applyTodo(emptyState(), { action: 'create', subject: 'old verified requirement', description: 'old scope' }).state;
  let confirmResolve: (value: boolean) => void = () => {}; let confirmText = '';
  h.ctx.ui.confirm = (_title: string, text: string) => { confirmText = text; return new Promise<boolean>(resolve => { confirmResolve = resolve; }); };
  const mutate = (params: any) => { const result = applyTodo(state, params); state = result.state; return result; };
  registerTodos(h.pi, { state: () => state, protected: () => false, mutate, commit: next => { state = next; }, reset() {}, async show() {} });
  const running = h.commands.get('todos').handler('', h.ctx); await tick();
  h.panels[0].render(80); h.panels[0].handleInput('\r'); await tick();
  h.panels[1].render(80); for (let i = 0; i < 3; i++) h.panels[1].handleInput('\x1b[B'); h.panels[1].handleInput('\r'); await tick();
  assert.equal(confirmText, 'old verified requirement');
  mutate({ action: 'update', id: 1, subject: 'new unverified requirement', description: 'new scope' });
  confirmResolve(true); await tick();
  assert.equal(state.tasks[0]!.subject, 'new unverified requirement'); assert.equal(state.tasks[0]!.status, 'pending');
  h.panels.at(-1).handleInput('\x1b'); await running;
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
    return undefined;
  };
  registerPlan(h.pi, { state: () => state, protected: () => false, commit: next => { state = next; }, assertCanEnter() {}, onEnter() {}, loadConfig: async () => ({ planTools: [] }) as any });
  await h.emit('session_start'); await h.commands.get('plan').handler('settings', h.ctx);
  assert.equal(state.plan, modeChange); assert.deepEqual(state.planTools, modeChange ? [] : ['other_search']);
});
