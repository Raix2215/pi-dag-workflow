import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRuntime } from "../src/agents/domain/runtime.ts";
import { ProfileStore } from "../src/agents/domain/profiles.ts";
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { AgentSendError } from "../src/agents/domain/runtime.ts";
import { toolDisplay, jobSummary, modelSummary } from '../src/shared/ui/presentation.ts';
import { chinese, createTranslator } from '../src/shared/i18n.ts';
import { AgentNotices, type Notice } from '../src/agents/io/notices.ts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager, Theme } from '@earendil-works/pi-coding-agent';
import { completeArguments, safeCompletionText, tokenMatches, type CompletionSpec } from '../src/shared/completion.ts';
import { emptyState, clearTodoRecords } from "../src/todos/domain/state.ts";
import { claimedBy } from '../src/agents/commands/register.ts';
import type { WorkflowState } from "../src/shared/task-types.ts";
import { GOAL_TYPE, type GoalState } from "../src/goal/domain/state.ts";
import { registerTodos } from '../src/todos/commands/register.ts';
import { registerPlan } from '../src/plan/commands/register.ts';
import { registerGoal } from "../src/goal/commands/register.ts";
import { registerAgents } from "../src/agents/commands/register.ts";
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { renderTasks, renderDag, renderWidget } from '../src/shared/ui/render.ts';
import { filteredView, latestBoundJobs, taskFilterStatus } from '../src/shared/ui/filter.ts';
import type { AgentView } from '../src/shared/agent-view.ts';
import { statusLabel } from '../src/todos/domain/state.ts';
import { dagLayout } from '../src/shared/dag/layout.ts';
import { dagStructure } from '../src/shared/dag/cache.ts';
import { AGENTS_TYPE, type Todo } from './fixtures/public-records.ts';
import { fragmentContext } from '../src/agents/domain/context.ts';
import { retryHost } from './fixtures/retry-public-host.ts';
import { protocolHost } from './fixtures/agents-protocol-host.ts';
import { recordPanels } from './fixtures/public-host.ts';
import { retryWidgetLine } from '../src/workflow/commands/view.ts';

// Pure report projection, moved from flow-persistence.test.ts.
test('fragment heads preserve whitespace and Unicode semantics without requiring the full report', () => {
  const tasks: Todo[] = [{ id: 1, subject: 'First', status: 'completed', blockedBy: [], metadata: { preset: 'probe', run: 1, key: 'first', step: 1 } }, { id: 2, subject: 'Last', status: 'pending', blockedBy: [1], metadata: { preset: 'probe', run: 1, key: 'last', step: 2 } }];
  for (const output of ['   short\n\ttext   ', 'a'.repeat(200) + ' '.repeat(5000), ' '.repeat(5000) + 'a '.repeat(1000), '𐐀'.repeat(1500), 'a'.repeat(199) + '𐐀tail', 'first\u00a0second ' + 'x'.repeat(10000)]) {
    const flat = output.replace(/\s+/g, ' ').trim(); let expected = flat.slice(0, 200); if (/[\uD800-\uDBFF]/.test(expected.at(-1) ?? '')) expected = expected.slice(0, -1);
    assert.ok(fragmentContext(2, tasks, [{ todoId: 1, status: 'completed', output }])!.includes(`- first (done): ${expected}${flat.length > 200 ? '…' : ''}`));
  }
  assert.doesNotMatch(fragmentContext(2, tasks, [{ todoId: 1, status: 'completed', output: '𐐀HIDDEN', outputStart: 1 }])!, /HIDDEN/);
});
import { choose, readView, bindMenuDisplay, menuDisplayOpen, withMenuScope, panelOptions, type MenuItem, type MenuCursor, panelEdit } from '../src/shared/ui/menu.ts';
import type { RpcRecord } from "./fixtures/isolated-client.ts";
import { createWorkflow } from '../src/workflow/index.ts';
import { createPanelRegistry } from '../src/workflow/commands/connect.ts';
import { valueToneFor } from '../src/shared/ui/panel.ts';
import { STATE_TYPE } from '../src/todos/domain/state.ts';
import { PLAN_TYPE } from '../src/plan/domain/state.ts';
import { widgetHeightBudget } from '../src/shared/ui/render.ts';

// ui-projection.test.ts
{
test('lightweight UI job projection excludes model/tools/private output and cannot mutate runtime', async () => {
  const model = { provider: 'test', id: 'model' };
  const runtime = new AgentRuntime({ cwd: '.', profiles: new ProfileStore({ registry: { find: () => model } }), getInheritedModel: () => model });
  try {
    await runtime.importSummaries([{ id: 'a1', todoId: 1, profile: 'test', status: 'completed', model, tools: ['read'], thinking: 'off', startedAt: 1, pendingRequests: 0, output: 'private result', requests: [] }]);
    const view = runtime.viewSummaries();
    assert.deepEqual(view, [{ id: 'a1', todoId: 1, profile: 'test', model, status: 'completed' }]);
    // U1 needs the actual model for inherit display; private execution fields stay excluded.
    assert.doesNotMatch(JSON.stringify(view), /tools|private|output/);
    view[0]!.profile = 'changed';
    assert.equal(runtime.inspect('a1')[0]!.profile, 'test');
    view[0]!.model.id = 'changed-model';
    assert.deepEqual(runtime.inspect('a1')[0]!.model, model);
    assert.equal((await runtime.wait('a1', { timeout: 0 })).output, 'private result');
  } finally { await runtime.shutdown(); }
});
}

// command-view-unification.test.ts
{
test('structured send failures render phase, status and impact instead of a bare error', () => {
  const details = { jobId: 'a1', stage: 'preflight' as const, status: 'waiting' as const, interrupted: false, queueCleared: false, questionsCleared: false, toolsApplied: null, directionDelivery: 'not_sent' as const, currentTools: ['read'], requestedTools: ['read', 'write'], error: 'unavailable tool', recovery: 'Choose an allowed tool' };
  const error = new AgentSendError('tools rejected', details);
  const rendered = toolDisplay({ ...error.details, error: error.message }, 'fallback body', createTranslator('en'));
  assert.match(rendered, /Recovery: Preflight/);
  assert.match(rendered, /tools rejected/, 'concrete rejection must remain visible');
  assert.match(rendered, /Waiting for reply/);
  assert.match(rendered, /Direction not sent/);
  assert.match(rendered, /Existing queue retained/);
  assert.match(rendered, /Choose an allowed tool/);
  assert.doesNotMatch(rendered, /fallback body/);
});

test('plugin-owned recovery guidance is localized without translating arbitrary diagnostic text', () => {
  const messages = [
    'The child stopped; inspect partial files and external effects before an explicitly authorized resumeFrom attempt. Queue/question waits are not restored automatically.',
    'The child is still active without a confirmed new direction. Inspect its current output and pending messages before sending again; do not blindly replay.',
    'This request did not interrupt or change permissions. Correct the tool selection and retry, or answer the original question if the child is still waiting.',
  ];
  for (const recovery of messages) {
    const details = { jobId: 'a1', stage: 'deliver_direction', status: 'running', directionDelivery: 'not_sent', currentTools: ['read'], error: 'Original provider diagnostic', recovery };
    const zh = toolDisplay(details, '', createTranslator('zh-CN')), en = toolDisplay(details, '', createTranslator('en'));
    assert.match(zh, /说明：.*[\u4e00-\u9fff]/); assert.doesNotMatch(zh, /说明：(?:The child|This request)/);
    assert.ok(en.includes(recovery)); assert.ok(zh.includes(details.error));
    assert.doesNotMatch(zh, /工具未调整|未中断当前运行/);
  }
});

/** The marker starts a fresh record window for one command. */
async function run(client: IsolatedClient, command: string) {
  const mark = client.records.length;
  await client.prompt(command);
  const records = client.records.slice(mark);
  return {
    notifications: records.filter((record) => record.method === 'notify').map((record) => String(record.message)),
    ui: records.filter((record) => ['select', 'input', 'editor', 'confirm'].includes(String(record.method))),
  };
}

test('bare root commands keep the native GUI while argument subcommands only notify readable text', { timeout: 60000 }, async (t) => {
  const client = await IsolatedClient.start(); t.after(() => client.close());

  // Root entries still open the native selector (paging header included), then cancel.
  for (const root of ['/agents', '/retry']) {
    const mark = client.records.length;
    const opening = client.prompt(root);
    await client.until(() => client.records.slice(mark).some((record) => record.method === 'select'));
    const menu = client.records.slice(mark).find((record) => record.method === 'select')!;
    assert.match(String(menu.title), /第 1\/\d+ 页 · 共 \d+ 项/, `${root} root menu still paginates`);
    client.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: menu.id, cancelled: true })}\n`);
    await opening;
  }

  for (const command of ['/agents list', '/agents profiles', '/agents wait', '/retry models', '/todos list', '/todos list pending', '/todos presets']) {
    const { notifications, ui } = await run(client, command);
    assert.deepEqual(ui, [], `${command} must not open a management menu or read view`);
    assert.ok(notifications.length > 0, `${command} notifies readable text`);
    assert.ok(!notifications.some((text) => text.trim().startsWith('{') || text.trim().startsWith('[')), `${command} never dumps raw JSON`);
  }

  // Precise commands missing a required argument print usage instead of opening anything.
  const wait = await run(client, '/agents wait');
  assert.deepEqual(wait.ui, []);
  assert.ok(wait.notifications.some((text) => text.includes('/agents wait jobId')));
  const after = await run(client, '/retry models after');
  assert.deepEqual(after.ui, []);
  assert.ok(after.notifications.some((text) => text.includes('/retry models after')));

  // A settings view keeps its actual state in readable text, not JSON or a nested menu.
  const models = await run(client, '/retry models');
  assert.match(models.notifications.join('\n'), /自动重试|替代模型/);
});

test('localized notifications cover both languages without UI menus', { timeout: 60000 }, async (t) => {
  const client = await IsolatedClient.start(undefined, 'm1-en', [], [], false, undefined, 'en'); t.after(() => client.close());
  const models = await run(client, '/retry models');
  assert.deepEqual(models.ui, []);
  assert.match(models.notifications.join('\n'), /Automatic retry|Model fallback/);
  const jobs = await run(client, '/agents list');
  assert.deepEqual(jobs.ui, []);
  assert.match(jobs.notifications.join('\n'), /No jobs/);
});
}

// completion.test.ts
{
const values = (items: { value: string }[] | null) => (items ?? []).map((item) => item.value);

test('completeArguments: root sub-actions, view second level, ids, prefix and spaces', () => {
  const spec: CompletionSpec = {
    actions: [
      { action: 'start', description: '开始任务' },
      { action: 'view', description: '切换视图' },
      { action: 'add', description: '新建任务' },
      { action: 'edit', description: '修改标题' },
    ],
    subActions: { view: [{ action: 'list', description: '列表' }, { action: 'dag', description: '图' }] },
    freeText: ['add'],
    tokens: (action) => [
      { token: '#41', label: '#41 调查' },
      { token: '#42', label: '#42 实现' },
    ].filter((entry) => action !== 'start' || entry.token !== '#42'),
  };

  // Empty input offers every root action.
  assert.deepEqual(values(completeArguments('', spec)), ['start', 'view', 'add', 'edit']);
  // Partial root action filters.
  assert.deepEqual(values(completeArguments('vi', spec)), ['view']);

  // A finished argument offers nothing so Enter submits instead of confirming a candidate.
  assert.equal(completeArguments('start', spec), null);

  // view second level completes with the full argument prefix.
  assert.deepEqual(values(completeArguments('view ', spec)), ['view list', 'view dag']);
  assert.deepEqual(values(completeArguments('view d', spec)), ['view dag']);
  assert.equal(completeArguments('view list', spec), null);
  assert.equal(completeArguments('view list ', spec), null);

  // Ids: trailing space lists valid ids and the value keeps the whole argument prefix.
  assert.deepEqual(values(completeArguments('start ', spec)), ['start #41']);
  assert.deepEqual(values(completeArguments('start #4', spec)), ['start #41']);
  assert.equal(completeArguments('start #41', spec), null);
  assert.equal(completeArguments('start #42', spec), null);
  // Multiple spaces collapse to the same token boundaries.
  assert.deepEqual(values(completeArguments('start   #4', spec)), ['start #41']);

  // Free text keeps what the user typed.
  assert.equal(completeArguments('add ', spec), null);
  assert.equal(completeArguments('add 标题', spec), null);
  assert.equal(completeArguments('edit #41 新标题', spec), null);

  // No match returns null.
  assert.equal(completeArguments('nope ', spec), null);
  assert.equal(completeArguments('zzz', spec), null);
  assert.equal(completeArguments('', { actions: [] }), null);
});

test('completeArguments: completion candidates carry no control characters or emoji', () => {
  const dirty = '调\u0007查\u0000😀';
  assert.equal(safeCompletionText(dirty), '调 查');
  // Nerd Font private-use glyphs and ordinary CJK text survive.
  assert.equal(safeCompletionText('\uf1c0 调研'), '\uf1c0 调研');

  const spec: CompletionSpec = {
    actions: [{ action: 'start', description: '开始' }],
    tokens: () => [{ token: '#41', label: `#41 ${dirty}`, description: `状态\u0001😀` }],
  };
  const items = completeArguments('start ', spec)!;
  assert.equal(items.length, 1);
  for (const item of items) {
    for (const text of [item.value, item.label, item.description ?? '']) {
      assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f\p{Extended_Pictographic}\uFE0F\u200D]/u);
    }
  }
  assert.equal(items[0]!.value, 'start #41');
});

test('completeArguments: token matching accepts bare and hashed ids', () => {
  assert.equal(tokenMatches('#41', ''), true);
  assert.equal(tokenMatches('#41', '#4'), true);
  assert.equal(tokenMatches('#41', '4'), true);
  assert.equal(tokenMatches('#41', '5'), false);
  assert.equal(tokenMatches('a1', 'a'), true);
});

// --- Actual registration wiring -------------------------------------------

interface FakePi { commands: Map<string, any>; handlers: Map<string, Function[]>; appended: unknown[]; tools: string[]; pi: any }
function fakePi(): FakePi {
  const commands = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const appended: unknown[] = [];
  const tools: string[] = [];
  const pi: any = {
    registerTool(definition: { name: string }) { tools.push(definition.name); },
    registerCommand(name: string, options: object) { commands.set(name, options); },
    registerFlag() {},
    on(event: string, handler: Function) { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); },
    appendEntry(type: string, data: unknown) { appended.push({ type, data }); },
    getAllTools: () => [],
  };
  return { commands, handlers, appended, tools, pi };
}

test('registered /todos, /plan and /goal expose argument completions over live state', async () => {
  const { pi, commands, handlers, appended } = fakePi();
  const state: WorkflowState = { ...emptyState(), nextId: 44, tasks: [
    { id: 41, subject: '调查', status: 'pending', blockedBy: [] },
    { id: 42, subject: '完成项', status: 'completed', blockedBy: [] },
    { id: 43, subject: '进行中', status: 'in_progress', blockedBy: [] },
  ] };
  registerTodos(pi, {
    state: () => state,
    mutate: () => { throw new Error('completion must not mutate'); },
    commit: () => { throw new Error('completion must not commit'); },
    show: async () => { throw new Error('completion must not show'); },
    protected: () => false, reset: () => {},
  });
  registerPlan(pi, { state: () => state, commit: () => { throw new Error('completion must not commit'); }, protected: () => false, assertCanEnter: () => {}, onEnter: () => {} });

  const todos = commands.get('todos').getArgumentCompletions;
  assert.equal(typeof todos, 'function');
  assert.deepEqual(values(await todos('')), ['add', 'start', 'done', 'pending', 'failed', 'cancelled', 'delete', 'edit', 'list', 'view', 'paths', 'flat', 'show', 'hide', 'clear', 'presets', 'apply', 'reset', 'help']);
  assert.deepEqual(values(await todos('view ')), ['view list', 'view dag']);
  assert.deepEqual(values(await todos('view list ')), ['view list full', 'view list pending', 'view list completed', 'view list failed', 'view list cancelled']);
  assert.deepEqual(values(await todos('view dag fa')), ['view dag failed']);
  assert.equal(await todos('view list failed'), null);
  assert.deepEqual(values(await todos('clear ')), ['clear completed', 'clear closed', 'clear all']);
  assert.equal(await todos('clear closed'), null);
  assert.deepEqual(values(await todos('list ')), ['list full', 'list pending', 'list completed', 'list failed', 'list cancelled']);
  assert.deepEqual(values(await todos('start ')), ['start #41', 'start #43']);
  assert.deepEqual(values(await todos('delete ')), ['delete #41', 'delete #42', 'delete #43']);
  assert.deepEqual(values(await todos('edit #4')), ['edit #41', 'edit #42', 'edit #43']);
  assert.equal(await todos('add '), null);
  assert.equal(await todos('nope '), null);

  const plan = commands.get('plan').getArgumentCompletions;
  assert.equal(typeof plan, 'function');
  assert.deepEqual(values(await plan('')), ['start', 'off', 'status', 'settings', 'tools', 'help']);

  // Seed the Goal state through the real session_start restore path.
  const goalState: GoalState = { version: 1, focusId: 1, nextId: 3, run: { paused: true, used: 0, stalled: 0 }, goals: [
    { id: 1, title: '进行中的目标', status: 'active', maxTurns: 20, createdAt: 1 },
    { id: 2, title: '已完成目标', status: 'completed', maxTurns: 20, createdAt: 1 },
  ] };
  registerGoal(pi, { state: () => state, jobs: () => [], paint: () => {}, protected: () => false, pauseAgents: () => {}, resumeAgents: () => {} });
  const ctx: any = { ui: { notify: () => {} }, sessionManager: { getBranch: () => [{ type: 'custom', customType: GOAL_TYPE, data: goalState }] } };
  for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx);

  const goal = commands.get('goal').getArgumentCompletions;
  assert.equal(typeof goal, 'function');
  // One spelling per operation: no alias candidates exist.
  assert.deepEqual(values(await goal('')), ['new', 'list', 'enable', 'disable', 'complete', 'delete', 'edit', 'get', 'nopause', 'nolimit', 'autoresearch', 'config', 'reset', 'help']);
  assert.deepEqual(values(await goal('enable ')), ['enable #1']);
  assert.deepEqual(values(await goal('nopause ')), ['nopause #1']);
  assert.deepEqual(values(await goal('nolimit ')), ['nolimit #1']);
  assert.deepEqual(values(await goal('autoresearch ')), ['autoresearch #1']);
  assert.equal(await goal('nocomplete '), null, 'no nocomplete alias is registered');
  assert.equal(await goal('nopause #1'), null, 'a complete nopause command submits without a second Enter');
  assert.deepEqual(values(await goal('nopause #1 ')), ['nopause #1 on', 'nopause #1 off']);
  assert.deepEqual(values(await goal('nolimit #1 of')), ['nolimit #1 off']);
  assert.equal(await goal('nopause #1 on'), null, 'a complete on/off setting submits');
  assert.equal(await goal('policy '), null, 'policy is not retained as a command alias');
  assert.deepEqual(values(await goal('delete ')), ['delete #1', 'delete #2']);
  assert.equal(await goal('new '), null);

  // Registering and completing performed no mutations or session writes of its own.
  assert.deepEqual(appended, []);
});

test('registered /agents exposes completions without a running runtime', async () => {
  const { pi, commands } = fakePi();
  registerAgents(pi, { validateDispatch() {}, resetTasks() { return []; }, state: () => emptyState(), mutate: () => {}, paint: () => {}, protected: () => false });
  const agents = commands.get('agents').getArgumentCompletions;
  assert.equal(typeof agents, 'function');
  assert.deepEqual(values(await agents('')), ['list', 'wait', 'send', 'reply', 'cancel', 'remove', 'pause', 'resume', 'profiles', 'profile', 'unprofile', 'reset', 'help']);
  // No runtime or profiles yet: dynamic positions and free text stay untouched.
  assert.equal(await agents('wait '), null);
  assert.equal(await agents('unprofile '), null);
  assert.equal(await agents('profile '), null);
  assert.equal(await agents('reply '), null);
});

test('actual Pi resource loader registers argument completions on every command', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pi-dag-completion-'));
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const loader = new DefaultResourceLoader({ cwd: temporary, agentDir: join(temporary, 'agent'), settingsManager: SettingsManager.inMemory({}), additionalExtensionPaths: [root], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const commands = new Map(loaded.extensions.flatMap((resource) => [...resource.commands.entries()]));
    for (const name of ['todos', 'plan', 'goal', 'agents']) {
      const command = commands.get(name);
      assert.ok(command, `missing /${name}`);
      assert.equal(typeof command!.getArgumentCompletions, 'function', `/${name} has no getArgumentCompletions`);
      const items = await command!.getArgumentCompletions!('');
      assert.ok(Array.isArray(items) && items.length > 0, `/${name} returned no root suggestions`);
    }
    // The todos command wires the view second level in the real loader too.
    assert.deepEqual(values(await commands.get('todos')!.getArgumentCompletions!('view ')), ['view list', 'view dag']);
    assert.equal(await commands.get('todos')!.getArgumentCompletions!('zzz '), null);
    loaded.runtime.invalidate();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
}

// help.test.ts
{
test('help is local and read-only: no model calls, mode changes, new tasks or Goal budget resets', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(); t.after(() => client.close());
  for (const command of ['/todos help', '/plan help', '/agents help', '/goal help']) {
    const records = await client.prompt(command);
    assert.ok(records.some((record) => record.method === 'notify'));
    assert.ok(!records.some((record) => record.type === 'agent_start'));
  }
  assert.ok(!(await client.entries() as any[]).some((entry) => entry.type === 'custom'));
});
}

// menu.test.ts
{
const plain = (text: string) => stripTerminalSequences(text);
function host(mode: 'tui' | 'rpc' | 'print' | 'json' | undefined = 'rpc') {
  const calls: { title: string; options: string[]; signal?: AbortSignal }[] = [], notices: string[] = [], styles: { text: string; fg: string; bold: boolean }[] = [];
  const custom: { render(width: number): string[]; handleInput?(data: string): void; invalidate(): void; focused?: boolean }[] = [], frames: string[][] = [], redraws: boolean[] = [], mounts: (unknown)[] = [];
  let hidden = false, disposed = 0;
  const builtin = JSON.parse(readFileSync(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json', import.meta.url), 'utf8'));
  const colors = Object.fromEntries(Object.keys(builtin.colors).map(token => [token, '#808080']));
  const theme = new Theme(colors as never, colors as never, 'truecolor'), paint = theme.style.bind(theme);
  theme.style = ((text: string, options: { fg: string; bold?: boolean }) => { styles.push({ text, fg: options.fg, bold: options.bold ?? false }); return paint(text, options as never); }) as typeof theme.style;
  if (mode === 'tui') { const stdout = process.stdout as { columns?: number; rows?: number }; stdout.columns = stdout.columns ?? 120; stdout.rows = stdout.rows ?? 30; }
  let select: (title: string, options: string[], signal?: AbortSignal) => Promise<string | undefined> = async () => undefined;
  let input: () => Promise<string | undefined> = async () => undefined;
  const finishes: ((value?: unknown) => void)[] = [];
  const ctx = {
    mode, hasUI: !['print', 'json'].includes(mode ?? ''), sessionManager: {},
    ui: {
      theme,
      select: (title: string, options: string[], opts?: { signal?: AbortSignal }) => { if (mode === 'rpc' || mode === undefined) assert.equal(custom.length, 0, 'native RPC choose must not mount custom UI'); calls.push({ title, options, ...(opts?.signal ? { signal: opts.signal } : {}) }); return select(title, options, opts?.signal); },
      input: () => input(), editor: () => input(), notify: (text: string) => notices.push(text),
      custom: (factory: Function, options?: unknown) => new Promise(resolve => {
        mounts.push(options);
        const tui = { terminal: { get rows() { return process.stdout.rows ?? 30; }, columns: 100 }, requestRender(force?: boolean) { redraws.push(force === true); const component = custom.at(-1); if (component && !hidden) frames.push(component.render(tui.terminal.columns)); } };
        // `done` may be called twice (host close, then the panel's own teardown): count one disposal.
        let settled = false;
        const finish = (value: unknown) => { if (settled) return; settled = true; disposed++; resolve(value); };
        const component = factory(tui, theme, {}, finish);
        finishes.push(finish);
        component.focused = true; custom.push(component); tui.requestRender();
      }),
    },
  } as unknown as ExtensionContext;
  return { ctx, calls, notices, styles, custom, frames, redraws, mounts, disposed: () => disposed, hidden: () => hidden,
    /** Close the mounted component from outside, as /reload or a host-side Esc would. */
    finish: (value?: unknown) => { finishes.at(-1)?.(value); },
    render: (width = 100) => custom.at(-1)!.render(width).map(plain),
    key: (data: string) => custom.at(-1)!.handleInput?.(data),
    select: (fn: typeof select) => { select = fn; }, input: (fn: typeof input) => { input = fn; } };
}
const items = (n: number): MenuItem[] => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, label: `Item ${i}` }));

test('native paging selects the later item and retains the returned cursor', async () => {
  const h = host(), cursor: { page?: number; selectedId?: string } = {}; let step = 0;
  h.select(async (_title, options) => ++step === 1 ? options.find(value => value === '下一页') : options.find(value => value === 'Item 8'));
  assert.equal(await choose(h.ctx, 'Pick', items(10), { cursor }), 'i8');
  assert.equal(cursor.page, 1); assert.equal(cursor.selectedId, 'i8'); assert.match(h.calls[1]!.title, /2\/2/);
});

test('native search filters records beyond the current page and cancelling search preserves the query', async () => {
  const h = host(), cursor: { query?: string } = {}; let step = 0;
  h.input(async () => 'Item 19'); h.select(async (_title, options) => ++step === 1 ? options.find(value => value === '搜索') : options.find(value => value === 'Item 19'));
  assert.equal(await choose(h.ctx, 'Search', items(20), { searchable: true, cursor }), 'i19'); assert.equal(cursor.query, 'Item 19');
  step = 0; h.input(async () => undefined); h.select(async (_title, options) => ++step === 1 ? options.find(value => value === '搜索') : options.find(value => value === 'Item 19'));
  assert.equal(await choose(h.ctx, 'Search', items(20), { searchable: true, cursor }), 'i19'); assert.equal(cursor.query, 'Item 19');
});

test('disabled choices stay visible with a reason and cannot execute', async () => {
  const h = host(); let step = 0;
  h.select(async (_title, options) => ++step === 1 ? options.find(value => value.includes('no access')) : options.find(value => value === 'Allowed'));
  assert.equal(await choose(h.ctx, 'Pick', [{ id: 'blocked', label: 'Blocked', disabledReason: 'no access' }, { id: 'allowed', label: 'Allowed' }]), 'allowed'); assert.equal(h.calls.length, 2);
});

test('native fixed actions preserve their current values and return caller ids', async () => {
  const h = host(); h.select(async (_title, options) => options.find(value => value.startsWith('Save')));
  assert.equal(await choose(h.ctx, 'Pick', items(3), { actions: [{ id: 'save', label: 'Save', value: '2 entries' }] }), 'save');
  assert.ok(h.calls[0]!.options.some(value => value.includes('2 entries')));
  const confirmations: { title: string; effects: string }[] = [];
  h.ctx.ui.confirm = async (title, effects) => { confirmations.push({ title, effects }); return true; };
  h.select(async (_title, options) => options.find(value => value === 'Stop worker'));
  const selected = await choose(h.ctx, 'Workers', [{ id: 'stop', label: 'Stop worker', destructive: true, confirmation: { title: 'Stop Worker A?', consequences: 'Keep the session and its mailbox.', action: 'stop' } }]);
  assert.equal(selected, 'stop');
  assert.deepEqual(confirmations, [{ title: 'Stop Worker A?', effects: 'Keep the session and its mailbox.' }], 'an externally handled text-client action confirms exactly once with its own effects');
});

test('native TUI preserves identity and semantic state colors, and never uses an overlay', async () => {
  const h = host('tui');
  const pending = choose(h.ctx, 'Goal', [{ id: '12', label: '#12 Long completed objective', value: '已完成' }, { id: '18', label: '#18 Active objective', value: '活动' }, { id: '20', label: '#20 Waiting objective', value: '暂停' }, { id: '21', label: '#21 Failed objective', value: '失败' }]);
  h.render(); h.key('\r'); assert.equal(await pending, '12');
  for (const fg of ['accent', 'success', 'warning', 'error']) assert.ok(h.styles.some(style => style.fg === fg), fg);
  assert.ok(h.render().some(line => line.includes('#12 Long completed objective') && line.includes('已完成')), 'identity and status remain on the same row');
  assert.ok(h.styles.some(style => style.text === '已完成' && style.fg === 'success'), 'completed status is successful');
  assert.equal(h.calls.length, 0);
});

test('ticket02 kind-tagged intent selects the executable row when a readonly field shares its id', async () => {
  const h = host('tui'), applied: unknown[] = [], cursor: MenuCursor = {};
  const pending = choose(h.ctx, 'Goal', [{ id: 'shared', label: 'Toggle', kind: 'toggle', checked: false, run: value => applied.push(value) }], { cursor, panel: { id: 'goal:contract', single: false, upper: () => ({ rows: [{ id: 'shared', label: 'State', kind: 'readonly', value: 'Read-only' }] }) } });
  h.render(); h.key('G'); h.key('\r'); assert.equal(await pending, 'shared');
  assert.deepEqual(applied, [true]); assert.equal(cursor.handled, true); assert.equal(cursor.kind, 'toggle');
});

test('ticket02 a child entity expands in place and Esc closes one level at a time', async () => {
  const h = host('tui');
  const pending = choose(h.ctx, 'Agents', [{ id: 'profile', label: 'Profile', kind: 'entity', children: [{ id: 'nested', label: 'Nested directory', kind: 'entity', children: [{ id: 'field', label: 'Field', kind: 'readonly' }] }] }], { panel: { id: 'agents:contract' } });
  h.render(); h.key('\r'); h.render();
  assert.ok(h.render().some(line => line.includes('Nested directory')), 'the child entity is visible inside the parent');
  h.key('\r'); h.render();
  assert.ok(h.render().some(line => line.includes('Field')), 'its own rows open in place, without swapping the page');
  assert.equal(h.disposed(), 0, 'the enclosing chooser stays mounted');
  h.key('\x1b'); h.render();
  assert.ok(h.render().some(line => line.includes('Nested directory')), 'Esc closes only the nested level');
  assert.ok(!h.render().some(line => line.includes('Field')), 'the nested rows are gone');
  assert.equal(h.disposed(), 0);
  h.key('\x1b'); h.key('\x1b'); assert.equal(await pending, undefined); assert.equal(h.disposed(), 1);
});

test('setting values infer semantic tones separately from action labels and attention states', async () => {
  const h = host('tui'); h.select(async () => undefined);
  const pending = choose(h.ctx, 'Settings', [{ id: 'research', label: 'Continuous research', value: 'Enabled', valueTone: 'dim' }, { id: 'failed', label: '#1 Failed task', value: '失败' }], { actions: [{ id: 'summary', label: 'Show summary', value: 'Disabled', valueTone: 'dim' }] });
  h.render(); h.key('\x1b'); await pending;
  assert.ok(h.styles.some(style => style.text === 'Enabled' && style.fg === 'accent' && !style.bold));
  assert.ok(h.styles.some(style => style.text === 'Disabled' && style.fg === 'dim' && !style.bold));
  assert.ok(h.styles.some(style => style.text === '失败' && style.fg === 'error'));
  assert.ok(!h.styles.some(style => style.text === 'Continuous research' && style.fg === 'dim'));
});

test('a directory never embeds long history, requirements or a preview of an unselected record', async () => {
  const h = host(); h.select(async () => undefined);
  await choose(h.ctx, 'Goal', items(20), { searchable: true, lines: () => ['Scope\n' + 'DO NOT INLINE HISTORY '.repeat(200)] });
  assert.doesNotMatch(h.calls[0]!.title, /DO NOT INLINE HISTORY|Scope/); assert.ok(h.calls[0]!.title.split('\n').length === 2);
});

test('a selected action page has at most three short context lines; complete body remains separately viewable', async () => {
  const h = host(); await choose(h.ctx, 'Goal #1', items(3), { lines: ['Status: paused', 'Allowance: 4/32', 'Next action: verify', 'FULL BODY SHOULD NOT BE INLINE'] });
  assert.match(h.calls[0]!.title, /Status: paused/); assert.match(h.calls[0]!.title, /4\/32/); assert.doesNotMatch(h.calls[0]!.title, /FULL BODY/);
});

test('native duplicate labels select the correct stable id', async () => {
  const h = host(); h.select(async (_title, options) => options.find(value => value === 'Same (2)'));
  assert.equal(await choose(h.ctx, 'Pick', [{ id: 'a', label: 'Same' }, { id: 'b', label: 'Same' }]), 'b');
});

test('duplicate-label suffixes cannot collide with a literal label', async () => {
  const h = host(); h.select(async (_title, options) => options[2]);
  assert.equal(await choose(h.ctx, 'Pick', [{ id: 'a', label: 'Same' }, { id: 'b', label: 'Same' }, { id: 'c', label: 'Same (1)' }]), 'c');
  assert.equal(new Set(h.calls[0]!.options).size, h.calls[0]!.options.length);
});

test('expiry aborts the native dialog and never commits its draft cursor', async () => {
  const h = host(), cursor = { selectedId: 'keep' }; let current = true;
  h.select(async () => new Promise(() => {}));
  const pending = choose(h.ctx, 'Pick', items(10), { cursor, isCurrent: () => current });
  await new Promise(resolve => setTimeout(resolve, 150)); current = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { assert.equal(await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expired native dialog did not close')), 2000); })]), undefined); }
  finally { clearTimeout(timer); }
  assert.deepEqual(cursor, { selectedId: 'keep' }); assert.equal(h.calls[0]!.signal?.aborted, true);
});

test('native text reader pages the entire body and is read-only, with restrained bold labels', async () => {
  const h = host('tui'), original = Array.from({ length: 40 }, (_, i) => `Scope line ${i}`).join('\n');
  const pending = readView(h.ctx, 'Full scope', original), seen = new Set<string>();
  for (let step = 0; step < 40; step++) { for (const line of h.render()) if (/Scope line/.test(line)) seen.add(line.trim()); h.key('j'); }
  for (let i = 0; i < 40; i++) assert.ok(seen.has(`Scope line ${i}`), `full body line ${i} remains accessible`);
  assert.doesNotMatch(h.render().join('\n'), /编辑|保存|Enter/); h.key('\x1b'); await pending;
  assert.equal(h.calls.length, 0); assert.equal(h.disposed(), 1);
});

test('reader body fits the native list padding without extra single-character wrapped rows', async () => {
  const h = host('tui'), oldCols = process.stdout.columns, oldRows = process.stdout.rows;
  process.stdout.columns = 52; process.stdout.rows = 22;
  h.select(async () => undefined);
  try {
    const pending = readView(h.ctx, 'Reader', '汉字正文'.repeat(50));
    for (const value of h.render(52)) assert.ok(visibleWidth(value) <= 52, 'docked body uses the terminal width with a two-column cursor slot');
    h.key('\x1b'); await pending;
  } finally { process.stdout.columns = oldCols; process.stdout.rows = oldRows; }
});

test('native resize preserves the first visible paragraph while re-opening the reader', async () => {
  const h = host('tui'), oldRows = process.stdout.rows; process.stdout.rows = 42;
  try {
    const pending = readView(h.ctx, 'Reader', Array.from({ length: 60 }, (_, i) => `Paragraph ${i}`).join('\n'));
    for (let step = 0; step < 28; step++) h.key('j');
    assert.ok(h.render().some(value => value.includes('Paragraph 28')));
    process.stdout.rows = 30; assert.ok(h.render().some(value => value.includes('Paragraph 28')));
    assert.equal(h.custom.length, 1); h.key('\x1b'); await pending;
  } finally { process.stdout.rows = oldRows; }
});

test('the entire nested command hides our summary once and restores it only at the end', async () => {
  const h = host(), visibility: boolean[] = [];
  bindMenuDisplay(h.ctx, () => visibility.push(menuDisplayOpen(h.ctx)));
  await withMenuScope(h.ctx, async () => {
    h.select(async () => undefined); await choose(h.ctx, 'Directory', items(3));
    assert.equal(menuDisplayOpen(h.ctx), true); await readView(h.ctx, 'Body', 'ordinary line'); assert.equal(menuDisplayOpen(h.ctx), true);
  });
  assert.deepEqual(visibility, [true, false]); assert.equal(menuDisplayOpen(h.ctx), false);
});

test('old scope completion cannot restore widgets after a replacement session binding', async () => {
  const h = host(), old: boolean[] = [], fresh: boolean[] = [];
  bindMenuDisplay(h.ctx, () => old.push(menuDisplayOpen(h.ctx)));
  let finish: () => void = () => {}; const pending = withMenuScope(h.ctx, () => new Promise<void>(resolve => { finish = resolve; }));
  bindMenuDisplay(h.ctx, () => fresh.push(menuDisplayOpen(h.ctx))); finish(); await pending;
  assert.deepEqual(old, [true]); assert.deepEqual(fresh, []);
});

test('RPC/unknown clients use plain native dialogs and print/json never open UI', async () => {
  for (const mode of ['rpc', undefined] as const) { const h = host(mode); h.select(async (_title, options) => options[0]); assert.equal(await choose(h.ctx, 'Pick', items(3)), 'i0'); assert.doesNotMatch(h.calls[0]!.title + h.calls[0]!.options.join(''), /\x1b/); }
  for (const mode of ['print', 'json'] as const) { const h = host(mode); assert.equal(await choose(h.ctx, 'Pick', items(3)), undefined); await readView(h.ctx, 'Body', 'readable'); assert.equal(h.calls.length, 0); assert.deepEqual(h.notices, ['readable']); }
  const h = host(); const controller = new AbortController(); controller.abort(); await readView(h.ctx, 'Body', 'text', { signal: controller.signal }); assert.equal(h.calls.length, 0);
});

test('localized native options remain plain for RPC and semantic colors work in both languages', async () => {
  const h = host('tui'), msg = createTranslator('en'), pending = choose(h.ctx, 'Goals', [{ id: '1', label: '#1 Scope', value: msg('失败') }], { msg });
  h.render(); assert.ok(h.styles.some(style => style.fg === 'error')); assert.doesNotMatch(h.render().join('\n'), /[\u3400-\u9fff]/u); h.key('\x1b'); await pending;
});

// U1 opt-in panel lifecycle; the existing native flows above remain unchanged.
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
/**
 * Hold the loop with a real handle until the panel's own bounded scope inspection closes it. The inspection
 * timer is deliberately unref'd, so without a handle of its own the loop can end before the panel closes;
 * a real host always has other work, and this test holds the one it waits for.
 */
const untilDisposed = async (h: { disposed(): number }, deadlineMs = 3000): Promise<void> => {
  const deadline = performance.now() + deadlineMs;
  while (h.disposed() === 0) {
    if (performance.now() > deadline) throw new Error('the panel scope never closed');
    await tick();
  }
};
test('only explicit TUI panels mount custom UI; RPC keeps native actions and search', async () => {
  for (const mode of ['rpc', undefined] as const) {
    const h = host(mode); h.select(async (_title, options) => options.find(value => value === 'Exit'));
    // No production panel omits actions any more: text clients always list what the panel lists.
    assert.equal(await choose(h.ctx, 'Root', items(3), { panel: { id: 'root' }, actions: [{ id: 'exit', label: 'Exit' }] }), 'exit');
    assert.equal(h.custom.length, 0);
  }
  for (const mode of ['print', 'json'] as const) {
    const h = host(mode); assert.equal(await choose(h.ctx, 'Root', items(3), { panel: { id: 'root' } }), undefined); assert.equal(h.custom.length, 0);
  }
  const h = host('tui'), pending = choose(h.ctx, 'Root', items(3).map((item, index) => ({ ...item, ...(index === 0 ? { value: '失败' } : {}) })), { panel: { id: 'root', title: 'Retry', section: { id: 'retry', label: 'Retry' }, lines: ['Phase', 'Paused'] }, actions: [{ id: 'exit', label: 'Exit' }] });
  assert.equal(h.custom.length, 1); assert.equal(h.calls.length, 0); assert.ok(h.render().length <= 20);
  assert.ok(h.styles.some(style => style.text === '失败' && style.fg === 'error'), 'panel status values preserve semantic error color');
  h.key('G'); h.key('j'); h.key('\r'); assert.equal(await pending, 'i1'); assert.equal(h.disposed(), 1);
  const upper = choose(h.ctx, 'Models', [{ id: 'model', label: 'Public model', value: 'example-provider-'.repeat(9) }], { panel: { id: 'models', itemsZone: 'upper' } });
  for (const width of [24, 40, 80, 120]) for (const line of h.render(width)) assert.ok(visibleWidth(line) <= width, 'upper metadata cannot overflow narrow terminals');
  h.key('\r'); assert.equal(await upper, 'model');
});
test('inline mounting forces one full redraw on show and after a nested native dialog', async () => {
  const h = host('tui'), panel = { id: 'root', title: 'Retry', lines: ['Phase', 'Paused'] };
  await withMenuScope(h.ctx, async () => {
    const opening = choose(h.ctx, 'Root', items(3), { panel });
    assert.equal(h.mounts[0], undefined, 'inline custom mount passes no overlay options');
    assert.equal(h.redraws.filter(Boolean).length, 1, 'inline mount resets the render state once so no stale frame survives');
    h.key('G'); h.key('\r'); assert.equal(await opening, 'i0');
    const before = h.redraws.length;
    h.input(async () => 'unchanged');
    assert.equal(await panelEdit({ ctx: { ...h.ctx, mode: 'rpc' }, title: 'Non-TUI fallback' }), 'unchanged');
    assert.deepEqual(h.redraws.slice(before).filter(Boolean), [true], 'one full redraw follows a nested non-TUI native dialog');
    const returning = choose(h.ctx, 'Root', items(3), { panel }); h.key('\r'); assert.equal(await returning, 'i0');
    assert.equal(h.redraws.filter(Boolean).length, 3, 'each show re-anchors with one forced redraw');
  });
});

test('U7 inline mounting passes no options and re-reads terminal rows on every frame', async () => {
  const oldRows = process.stdout.rows, h = host('tui');
  const pending = choose(h.ctx, 'Resize', items(20), { panel: { id: 'resize' } });
  try {
    assert.equal(h.mounts[0], undefined, 'no overlay options');
    assert.equal(h.custom.length, 1);
    const heights: Record<number, number> = {};
    for (const rows of [30, 20, 14, 8]) { process.stdout.rows = rows; heights[rows] = h.render().length; assert.ok(heights[rows]! <= Math.max(1, rows - 1), `rows=${rows}`); }
    assert.ok(heights[30]! > heights[20]! && heights[20]! > heights[14]!, JSON.stringify(heights));
    assert.equal(heights[8], 4, 'rows <= 10 uses the compact shell');
    process.stdout.rows = 30;
    assert.equal(h.render().length, heights[30]);
    assert.equal(h.custom.length, 1, 'resize reuses the mounted interaction');
  } finally { process.stdout.rows = oldRows; h.key('\x1b'); await pending; }
});

test('panel readView flips the retained component in place and restores stable cursor and search', async () => {
  const h = host('tui'), cursor: { selectedId?: string; query?: string } = {}, panel = { id: 'root', title: 'Retry', section: { id: 'retry', label: 'Retry' }, lines: ['Phase', 'Paused'] };
  const pending = withMenuScope(h.ctx, async () => {
    assert.equal(await choose(h.ctx, 'Root', items(8), { panel, cursor, searchable: true }), 'i6');
    await readView(h.ctx, 'Report', Array.from({ length: 15 }, (_, index) => `Body ${index}`).join('\n'));
    assert.equal(await choose(h.ctx, 'Root', items(8), { panel, cursor, searchable: true }), 'i6');
  });
  h.key('G'); h.key('/'); h.key('Item 6'); h.key('\r'); await tick();
  assert.match(h.render().join('\n'), /Body 0/); assert.match(h.render().join('\n'), /j\/k 滚动/); assert.equal(h.custom.length, 1);
  h.key('j'); assert.match(h.render().join('\n'), /Body 5/); h.key('\x1b'); await tick();
  assert.match(h.render().join('\n'), /搜索：Item 6/); assert.match(h.render().join('\n'), /> .*Item 6/);
  h.key('\r'); await pending; assert.equal(cursor.selectedId, 'i6'); assert.equal(cursor.query, 'Item 6'); assert.equal(h.disposed(), 1);
});
test('Retry TUI keeps candidate editing inline and discards unsaved changes', { timeout: 10000 }, async t => {
  const retry = await retryHost(t), h = host('tui');
  retry.ctx.mode = 'tui'; retry.ctx.ui.theme = h.ctx.ui.theme;
  const panels = recordPanels(retry.ctx);
  retry.installModels('test/base', 'test/alpha', 'test/beta');
  const pending = retry.menu(); await retry.flush();
  assert.ok(panels.frame().length <= 20); assert.doesNotMatch(panels.frame().join('\n'), /退出菜单/); assert.match(panels.frame()[0]!, /Retry.*Display/, 'the Display tab joins any enabled module');
  await panels.select('重试间隔'); assert.match(panels.frame().join('\n'), /正在编辑/);
  await panels.press('\x1b'); await panels.select('替代模型');
  await panels.select('添加候选模型'); await panels.select('alpha');
  await panels.focus('1 alpha'); await panels.press('l');
  assert.match(panels.frame().join('\n'), /从草稿移除/);
  assert.doesNotMatch(panels.frame()[0]!, /替代模型|调整候选位置/, 'short menus stay inline and do not contaminate any Tab');
  await panels.select('从草稿移除');
  await panels.select('放弃草稿');
  await panels.press('\x1b'); await panels.press('\x1b'); await pending;
  assert.equal(retry.entries.length, 0); assert.equal(retry.requests.length, 0); assert.equal(panels.live(), 0);
});
test('ticket18 a stale handled flag never survives a closed panel and the module loop exits', async () => {
  const h = host('tui');
  // The engine clears a flag left over from an earlier call and reports the closure explicitly.
  const cursor: { handled?: boolean; closed?: boolean } = { handled: true };
  const panel = { id: 'todos', title: 'Todos' };
  const opening = choose(h.ctx, 'Todos', [{ id: 'run', label: 'Run', run: () => { cursor.handled = true; } }], { cursor, panel });
  await tick();
  h.finish();
  assert.equal(await opening, undefined, 'a closed panel answers undefined');
  assert.notEqual(cursor.handled, true, 'and leaves no handled flag behind');
  assert.equal(cursor.closed, true, 'it says the panel is gone so the caller stops looping');
  // The next call starts clean: the stale flag from before is ignored, not inherited.
  const second = choose(h.ctx, 'Todos', items(3), { cursor, panel });
  await tick();
  assert.equal(cursor.closed, undefined, 'entering a new call clears the closed marker');
  h.key('\r'); await second;
  assert.equal(cursor.closed, undefined);
  // The caller going away mid-call (isCurrent flipping false) is also a closure: report it, do not hide it.
  const stale: { handled?: boolean; closed?: boolean } = {};
  let live = true;
  const third = choose(h.ctx, 'Todos', items(3), { cursor: stale, panel, isCurrent: () => live });
  await tick();
  live = false;
  h.finish();
  assert.equal(await third, undefined);
  assert.equal(stale.closed, true, 'an abandoned call still reports the closure');
  assert.notEqual(stale.handled, true);
});

test('ticket18 a flight with no live panel is reclaimed after the stale threshold', async () => {
  const h = host('tui');
  const registry = createPanelRegistry(['todos', 'agents'], () => true, () => 0);
  const todos = registry.module({ id: 'todos', label: 'Todos' }), agents = registry.module({ id: 'agents', label: 'Agents' });
  // A module that never settles and never mounts: exactly the reported "no panel, but still holding".
  todos.register(async () => { await new Promise<void>(() => {}); });
  agents.register(async ctx => { await choose(ctx, 'Agents', items(4), { panel: panelOptions(agents, { id: 'agents', label: 'Agents' }, 'agents:root') }); });
  void todos.open(h.ctx);
  await tick();
  // Inside the threshold the registry still reports the busy flight.
  await agents.open(h.ctx);
  assert.match(h.notices.at(-1) ?? '', /另一个面板尚未关闭：先按 Esc 关闭它/);
  assert.equal(h.mounts.length, 0, 'nothing was mounted while the flight was held');
  await new Promise(resolve => setTimeout(resolve, 2_100));
  const recovered = agents.open(h.ctx);
  await tick();
  const notice = h.notices.filter(entry => /已关闭但未释放：已自动恢复/.test(entry)).at(-1);
  assert.ok(notice, `the recovery is reported: ${JSON.stringify(h.notices.slice(-3))}`);
  assert.match(notice!, /Todos/, 'the notice names the stale holder');
  assert.equal(h.mounts.length, 1, 'the recovered open really mounted');
  h.key('\x1b'); await recovered;
});

test('ticket18 a real module loop redraws instead of spinning when the panel closes mid-row', async t => {
  const host = await protocolHost({ features: ['todos'], language: 'zh-CN' });
  t.after(() => host.close());
  host.ctx.hasUI = true; host.ctx.mode = 'tui';
  host.ctx.ui.theme = { style: (text: string) => text, fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const panels = recordPanels(host.ctx);
  const opening = host.commands.get('todos').handler('', host.ctx);
  await panels.wait(() => panels.live() === 1);
  // Focus the cycle row: its inline run is what sets `handled`.
  for (let step = 0; step < 80; step++) {
    const selected = panels.frame().find(line => /^[ │]*> /.test(line));
    if (selected?.includes('筛选')) break;
    await panels.press('j');
  }
  const pressing = panels.press('\r');
  panels.finish();
  // The module must ask again and mount a fresh panel (that is the redraw), not spin on a stale flag.
  await panels.wait(() => panels.mounts() >= 2);
  const redraw = panels.mounts();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(panels.mounts(), redraw, 'the redraw waits for the next key instead of remounting in a loop');
  panels.finish();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    Promise.all([pressing, opening]).then(() => 'settled' as const),
    new Promise<'hung'>(resolve => { timer = setTimeout(() => resolve('hung'), 3000); }),
  ]);
  clearTimeout(timer);
  assert.equal(outcome, 'settled', 'closing the redrawn panel ends the loop');
});

test('ticket12 a panel closed behind the waiter releases the registry instead of blocking every later open', async () => {
  const h = host('tui');
  const registry = createPanelRegistry(['todos', 'agents'], () => true, () => 0);
  const todos = registry.module({ id: 'todos', label: 'Todos' }), agents = registry.module({ id: 'agents', label: 'Agents' });
  let opened = 0;
  todos.register(async ctx => { opened++; await choose(ctx, 'Todos', items(5), { panel: panelOptions(todos, { id: 'todos', label: 'Todos' }, 'todos:root') }); });
  agents.register(async ctx => { opened++; await choose(ctx, 'Agents', items(5), { panel: panelOptions(agents, { id: 'agents', label: 'Agents' }, 'agents:root') }); });
  // The first panel's waiter never gets an answer from the component: the host closes it instead.
  const first = todos.open(h.ctx);
  await tick();
  assert.equal(h.custom.length - h.disposed(), 1, 'the first panel is mounted');
  h.finish();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    assert.equal(await Promise.race([first.then(() => 'settled' as const), new Promise<'hung'>(resolve => { timer = setTimeout(() => resolve('hung'), 2000); })]), 'settled', 'a closed panel settles its waiter');
  } finally { clearTimeout(timer); }
  // The registry is free again: a second open mounts instead of returning silently.
  const second = agents.open(h.ctx);
  await tick();
  assert.equal(opened, 2, 'the second panel really opened');
  assert.equal(h.custom.length - h.disposed(), 1, 'one live panel');
  assert.match(h.render()[0]!, /Agents/);
  h.key('\x1b'); await second;
});

test('ticket12 an open already in flight is reported with an executable hint, never swallowed', async () => {
  const h = host('tui');
  const registry = createPanelRegistry(['todos', 'agents'], () => true, () => 0);
  const todos = registry.module({ id: 'todos', label: 'Todos' }), agents = registry.module({ id: 'agents', label: 'Agents' });
  let opened = 0;
  todos.register(async ctx => { opened++; await choose(ctx, 'Todos', items(5), { panel: panelOptions(todos, { id: 'todos', label: 'Todos' }, 'todos:root') }); });
  agents.register(async ctx => { opened++; await choose(ctx, 'Agents', items(5), { panel: panelOptions(agents, { id: 'agents', label: 'Agents' }, 'agents:root') }); });
  const first = todos.open(h.ctx);
  await tick();
  await agents.open(h.ctx);
  assert.equal(opened, 1, 'the second open never mounts on top of the first');
  const warning = h.notices.at(-1) ?? '';
  assert.match(warning, /另一个面板尚未关闭：先按 Esc 关闭它，或 \/reload 重载插件/, `warning: ${warning}`);
  assert.match(warning, /Todos/, 'the hint names the module holding the registry');
  h.key('\x1b'); await first;
  // Once the first panel closes, the registry accepts a new open again.
  const again = agents.open(h.ctx);
  await tick();
  assert.equal(opened, 2, 'a later open works after the first one closed');
  h.key('\x1b'); await again;
});

test('ticket08 a module keeps its panel memory across Esc and reopen while another module starts fresh', async () => {
  const h = host('tui');
  const registry = createPanelRegistry(['todos', 'agents'], () => true, () => 0);
  const todos = registry.module({ id: 'todos', label: 'Todos' }), agents = registry.module({ id: 'agents', label: 'Agents' });
  const opens: string[] = [];
  todos.register(async ctx => { opens.push('todos'); await choose(ctx, 'Todos', items(9), { panel: panelOptions(todos, { id: 'todos', label: 'Todos' }, 'todos:root') }); });
  agents.register(async ctx => { opens.push('agents'); await choose(ctx, 'Agents', items(9), { panel: panelOptions(agents, { id: 'agents', label: 'Agents' }, 'agents:root') }); });
  let pending = todos.open(h.ctx);
  h.key('j'); h.key('j'); await tick();
  assert.match(h.render().join('\n'), /> .*Item 2/);
  h.key('\x1b'); await pending;
  assert.equal(todos.memory(), undefined, 'closing the panel ends the flight');
  pending = todos.open(h.ctx); await tick();
  assert.match(h.render().join('\n'), /> .*Item 2/, 'Esc and reopen restore the cursor');
  h.key('\x1b'); await pending;
  const other = agents.open(h.ctx); await tick();
  assert.match(h.render().join('\n'), /> .*Item 0/, 'another module keeps its own bucket');
  h.key('\x1b'); await other;
  assert.deepEqual(opens, ['todos', 'todos', 'agents']);
});

test('Todos idle refresh paints changed task state without a key or remount', { timeout: 10000 }, async t => {
  const registered = await protocolHost({ features: ['todos'], language: 'zh-CN', state: { ...emptyState(), nextId: 2, tasks: [{ id: 1, subject: 'Before refresh', status: 'pending', blockedBy: [] }] } });
  const ui = host('tui');
  registered.ctx.hasUI = true; registered.ctx.mode = 'tui';
  registered.ctx.ui.theme = ui.ctx.ui.theme; registered.ctx.ui.custom = ui.ctx.ui.custom;
  t.mock.timers.enable({ apis: ['setInterval'] });
  const opening = registered.commands.get('todos').handler('', registered.ctx);
  try {
    const deadline = performance.now() + 5000;
    while (!ui.custom.length && performance.now() < deadline) await tick();
    assert.equal(ui.custom.length, 1);
    // Read only frames actually painted by requestRender, never a test-initiated render after the change.
    const painted = () => ui.frames.at(-1)!.map(stripTerminalSequences).join('\n');
    assert.match(painted(), /#1.*Before refresh/);
    const paints = ui.frames.length;
    await registered.call('todo', { action: 'update', id: 1, subject: 'After refresh', status: 'in_progress' });
    assert.equal(ui.frames.length, paints, 'the tool mutation itself did not repaint the open menu');
    t.mock.timers.tick(1000);
    assert.ok(ui.frames.length > paints, 'the real one-second menu timer requested a new frame');
    assert.match(painted(), /#1.*After refresh/);
    assert.doesNotMatch(painted(), /Before refresh/);
    assert.equal(ui.custom.length, 1, 'the same component and waiter stay mounted');
  } finally { ui.finish(); await opening; await registered.close(); }
});

test('Agents idle refresh paints report delivery without a key or remount', { timeout: 10000 }, async t => {
  const registered = await protocolHost({ features: ['todos', 'agents'], language: 'zh-CN', entries: [
    { type: 'custom', customType: STATE_TYPE, data: { ...emptyState(), nextId: 2, tasks: [{ id: 1, subject: 'Review report', status: 'pending', blockedBy: [] }] } },
    { type: 'custom', customType: AGENTS_TYPE, data: { version: 1, jobs: [{ id: 'a1', todoId: 1, profile: 'inherit', status: 'completed', model: { provider: 'dag-test', id: 'scripted' }, thinking: 'off', tools: ['read'], startedAt: 1, endedAt: 2, pendingRequests: 0, requests: [], output: 'Saved report', reportDelivery: 'pending' }] } },
  ] });
  const ui = host('tui');
  registered.ctx.hasUI = true; registered.ctx.mode = 'tui';
  registered.ctx.ui.theme = ui.ctx.ui.theme; registered.ctx.ui.custom = ui.ctx.ui.custom;
  t.mock.timers.enable({ apis: ['setInterval'] });
  const opening = registered.commands.get('agents').handler('', registered.ctx);
  try {
    const deadline = performance.now() + 5000;
    while (!ui.custom.length && performance.now() < deadline) await tick();
    assert.equal(ui.custom.length, 1);
    const painted = () => ui.frames.at(-1)!.map(stripTerminalSequences).join('\n');
    assert.match(painted(), /a1.*待交付/);
    const paints = ui.frames.length;
    const report = await registered.call('subagent_inspect', { jobId: 'a1', output: true, timeout: 0 });
    assert.equal(report.reportDelivery, 'delivered', 'the real runtime accepted the delivery transition');
    assert.equal(ui.frames.length, paints);
    t.mock.timers.tick(1000);
    assert.ok(ui.frames.length > paints, 'the real one-second menu timer requested a new frame');
    assert.match(painted(), /a1.*已返回/);
    assert.doesNotMatch(painted(), /待交付/);
    assert.equal(ui.custom.length, 1);
  } finally { ui.finish(); await opening; await registered.close(); }
});

test('ticket14 the plan config-tools editor keeps its leading pencil in the real panel', async t => {
  const host = await protocolHost({ features: ['todos', 'plan'], language: 'zh-CN' });
  t.after(() => host.close());
  host.ctx.hasUI = true; host.ctx.mode = 'tui';
  host.ctx.ui.theme = { style: (text: string) => text, fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const panels = recordPanels(host.ctx);
  const opening = host.commands.get('plan').handler('', host.ctx);
  await panels.wait(() => panels.live() === 1);
  const pencil = String.fromCodePoint(0xf03eb);
  const focus = async (word: string) => { for (const key of ['j', 'k']) for (let step = 0; step < 80; step++) { const selected = panels.frame().find((line: string) => /^[ │]*> /.test(line)); if (selected?.includes(word)) return; await panels.press(key); } throw new Error(`row not found: ${word}\n${panels.frame().join('\n')}`); };
  await focus('编辑配置文件只读工具');
  const line = panels.frame().find((value: string) => value.includes('编辑配置文件只读工具'))!;
  assert.match(line, new RegExp(`^[> ]{2}${pencil} 编辑配置文件只读工具`), `the pencil leads the row: ${line}`);
  assert.equal([...line].filter(char => char === pencil).length, 1, `exactly one pencil: ${line}`);
  await panels.press('\x1b'); await opening;
});

test('a replacement panel wait supersedes an old generation without losing its result or focus', async () => {
  const h = host('tui'), controller = new AbortController(); let oldLive = true;
  const old = choose(h.ctx, 'Old', items(3), { panel: { id: 'old' }, isCurrent: () => oldLive });
  oldLive = false;
  const next = choose(h.ctx, 'New', items(3), { panel: { id: 'new' }, signal: controller.signal });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    assert.equal(await old, undefined); assert.equal(h.hidden(), false);
    h.key('j'); h.key('\r');
    assert.equal(await Promise.race([next, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('New generation lost its panel waiter')), 1000); })]), 'i1');
    assert.equal(h.disposed(), 1);
  } finally { clearTimeout(timeout); controller.abort(); await Promise.allSettled([old, next]); }
});
test('U2 registry unmounts before command-level switching, keeps one live panel and restores search/cursor within the flight', async () => {
  const h = host('tui'), visibility: boolean[] = [];
  bindMenuDisplay(h.ctx, () => visibility.push(menuDisplayOpen(h.ctx)));
  const registry = createPanelRegistry(['todos', 'plan', 'goal'], id => id !== 'goal', () => 0);
  const todos = registry.module({ id: 'todos', label: 'Todos' }), plan = registry.module({ id: 'plan', label: 'Plan' });
  todos.register(async ctx => { await choose(ctx, 'Todos', items(9), { panel: panelOptions(todos, { id: 'todos', label: 'Todos' }, 'todos:root') }); });
  plan.register(async ctx => { await choose(ctx, 'Plan', [{ id: 'mode', label: 'Mode', kind: 'readonly' }], { panel: panelOptions(plan, { id: 'plan', label: 'Plan' }, 'plan:root', ['Mode', 'Entry']) }); });
  assert.deepEqual(todos.tabs().map(tab => tab.id), ['todos', 'plan']);
  const pending = todos.open(h.ctx);
  h.key('/'); h.key('Item 6'); h.key('\t'); await tick();
  assert.equal(h.custom.length - h.disposed(), 1); assert.equal(h.disposed(), 1);
  assert.match(h.render()[0]!, /Plan/); assert.doesNotMatch(h.render().at(-1)!, /Enter/);
  assert.deepEqual(visibility, [true, false, true]);
  const concurrent = plan.open(h.ctx); await concurrent; assert.equal(h.custom.length, 2);
  h.key('\x1b[Z'); await tick();
  assert.equal(h.custom.length - h.disposed(), 1); assert.equal(h.disposed(), 2);
  assert.match(h.render().join('\n'), /搜索：Item 6/); assert.match(h.render().join('\n'), /> .*Item 6/);
  h.key('\x1b'); h.key('\x1b'); await pending;
  assert.equal(h.disposed(), 3); assert.equal(menuDisplayOpen(h.ctx), false);
  assert.equal(todos.memory(), undefined);
});
test('expired TUI panel results do not commit cursor memory and dispose the custom interaction', async () => {
  const h = host('tui'), cursor = { selectedId: 'keep' }; let live = true;
  const pending = choose(h.ctx, 'Root', items(4), { panel: { id: 'root' }, cursor, isCurrent: () => live });
  h.key('j'); live = false;
  // The scope's own inspection closes the panel; wait for that real closure before awaiting its result.
  await untilDisposed(h);
  // The cursor memory is untouched; the only addition is the explicit closure marker (ticket 18).
  assert.equal(await pending, undefined); assert.deepEqual(cursor, { selectedId: 'keep', closed: true }); assert.equal(h.disposed(), 1);
});
}

// native-menu-flow.test.ts
{
const widgetKey = 'pi-dag-workflow.todos';
async function call(client: IsolatedClient, name: string, args: object) {
  const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(args)}`);
  const record = events.find(event => event.type === 'tool_execution_end' && event.toolName === name)!;
  assert.ok(record); assert.equal(record.isError, false); return (record.result as any).details;
}
function driver(client: IsolatedClient) {
  let at = client.records.length;
  return async (word?: string) => {
    await client.until(() => client.records.slice(at).some(record => record.method === 'select'));
    const index = client.records.findIndex((record, i) => i >= at && record.method === 'select'); const record = client.records[index]!; at = index + 1;
    if (word !== undefined) { const value = (record.options as string[]).find(value => value.includes(word)); assert.ok(value, word); client.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: record.id, value }) + '\n'); }
    else client.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: record.id, cancelled: true }) + '\n');
    return record;
  };
}
const latestWidget = (client: IsolatedClient): RpcRecord | undefined => client.records.filter(record => record.method === 'setWidget' && record.widgetKey === widgetKey).at(-1);

test('native Goal menu withdraws all own preview across nested pages and restores it without a state mutation', async t => {
  const client = await IsolatedClient.start(); t.after(() => client.close());
  const scope = ('Historical verification scope: ' + 'preserve complete requirements and evidence. '.repeat(50)).trim();
  await call(client, 'todo', { action: 'create', subject: 'Actual preview must not remain in the menu' });
  await call(client, 'goal', { action: 'create', title: 'Historical objective', description: scope });
  await call(client, 'goal', { action: 'complete', id: 1 });
  const requests = client.records.filter(record => record.type === 'agent_start').length;
  const choose = driver(client), opening = client.prompt('/goal');
  const directory = await choose('Historical objective');
  assert.doesNotMatch(String(directory.title), /Historical verification scope|preserve complete requirements/);
  assert.equal(latestWidget(client)?.widgetLines, undefined);
  const action = await choose('查看范围与进展'); assert.doesNotMatch(String(action.title), /Historical verification scope/);
  await client.until(() => client.records.some(record => record.method === 'notify' && String(record.message).includes(scope)));
  assert.equal(latestWidget(client)?.widgetLines, undefined, 'reading selected complete content remains within the same command scope');
  await choose(); assert.equal(latestWidget(client)?.widgetLines, undefined, 'back to directory does not restore preview yet');
  await choose(); await opening;
  assert.ok(JSON.stringify(latestWidget(client)?.widgetLines).includes('Actual preview must not remain'));
  const restored = await call(client, 'goal', { action: 'get', id: 1 }); assert.equal(restored.goalState.goals[0].description, scope); assert.equal(restored.goalState.goals[0].status, 'completed');
  assert.equal(client.records.filter(record => record.type === 'agent_start').length, requests + 1, 'only explicit final tool verification ran the scripted provider');
});

test('Plan settings is read-only text and keeps Plan state and preview', async t => {
  const client = await IsolatedClient.start(); t.after(() => client.close());
  await call(client, 'todo', { action: 'create', subject: 'Preview after Plan settings text' });
  const records = await client.prompt('/plan settings');
  assert.ok(records.some(record => record.method === 'notify' && String(record.message).includes('Plan 设置')), 'settings reports as text');
  assert.equal(records.some(record => record.method === 'select'), false, 'settings opens no dialog');
  assert.ok(JSON.stringify(latestWidget(client)?.widgetLines).includes('Preview after Plan settings text'));
  assert.equal((await call(client, 'todo', { action: 'status' })).status.mode, 'normal');
});
}

// U2–U4 production panel projections.
{
test('five production overlays keep compact geometry, complete tabs, Plane-15 output and guarded Plan controls', async t => {
  const retry = await retryHost(t, ['todos', 'plan', 'goal', 'agents', 'retry']);
  const builtin = JSON.parse(readFileSync(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json', import.meta.url), 'utf8'));
  const colors = Object.fromEntries(Object.keys(builtin.colors).map(key => [key, '#808080']));
  retry.ctx.mode = 'tui'; retry.ctx.ui.theme = new Theme(colors as never, colors as never, 'truecolor');
  const panels = recordPanels(retry.ctx);
  const call = async (params: object) => { const result = await retry.call('todo', params); assert.ok(!result.isError); };
  for (const [subject, blockedBy] of [['Root', []], ['Branch', [1]], ['Nested', [2]], ['Sibling', [1]], ['Other root', []]] as const) await call({ action: 'create', subject, blockedBy });
  const assertFrame = (module: string, infoRows: number) => {
    const frame = panels.frame(96); assert.ok(frame.length <= 24); assert.equal(panels.live(), 1);
    assert.match(frame[0]!, new RegExp(module));
    const rules = frame.flatMap((line, index) => /^─+$/.test(line) ? [index] : []);
    assert.equal(rules.length, 4, `${module} is dual-zone`); assert.ok(rules[1]! - 2 >= 1);
    assert.ok(rules[2]! - rules[1]! - 1 >= 1 && rules[2]! - rules[1]! - 1 <= 11, `${module} lower zone keeps 1..11 rows`);
    assert.equal(rules.at(-1)! - rules.at(-2)!, 3, `${module}: both hint slots stay present`); assert.match(frame.at(-1)!, /Tab/); assert.doesNotMatch(frame.at(-1)!, /\d+\/\d+/);
    assert.doesNotMatch(frame.join('\n'), /[\ue000-\uf8ff]/u);
    void infoRows;
    return frame;
  };
  const tab = async (input: string, module: string, info: number) => { await panels.press(input); await panels.wait(() => panels.live() === 1 && panels.active().includes(module)); return assertFrame(module, info); };
  const pending = retry.commands.get('todos').handler('', retry.ctx);
  await panels.wait(() => panels.live() === 1);
  const tasksFrame = assertFrame('Todos', 0);
  // The upper zone scrolls: collect frames while walking the tree, then assert on the whole tree text.
  const seen = new Set(tasksFrame);
  for (let step = 0; step < 8; step++) { await panels.press('j'); panels.frame().forEach(line => seen.add(line)); }
  const tasksText = [...seen].join('\n');
  assert.match(tasksText, /├─ #1 +○ Root/); assert.match(tasksText, /│  ├─ #2 +○ Branch/); assert.match(tasksText, /│  │  └─ #3 +○ Nested/); assert.match(tasksText, /│  └─ #4 +○ Sibling/); assert.match(tasksText, /└─ #5 +○ Other root/);
  assert.match(tasksText, /Task 片段/, 'fragments live in the second upper group');
  await panels.select('筛选'); assertFrame('Todos', 0); assert.match(panels.frame().join('\n'), /筛选.*待执行/);
  const plan = await tab('\t', 'Plan', 2); assert.match(plan.at(-1)!, /Enter/);
  const writes = retry.entries.length; await panels.press('\x1b[B'); await panels.press('\r'); assert.equal(retry.entries.length, writes); assert.match(panels.frame().join('\n'), /只读限制.*写入\/Shell\/派发/);
  await retry.call('goal', { action: 'create', title: 'overlay probe' });
  const goalFrame = await tab('\t', 'Goal', 2);
  assert.match(goalFrame.join('\n'), /轮次进度/);
  assert.doesNotMatch(goalFrame.join('\n'), /续跑进度/, 'the information band is the only source of the turn counters');
  await panels.focus('重置 Goal 记录');
  assert.match(panels.frame().join('\n'), /重置 Goal 记录/);
  await panels.press('\r');
  assert.match(panels.frame().join('\n'), /再次 Enter 重置/, 'reset names its action and requires another Enter'); await panels.press('x');
  await tab('\t', 'Agents', 0);
  await tab('\t', 'Retry', 2); assert.doesNotMatch(panels.frame().join('\n'), /显示摘要/);
  // The sixth tab is the Display panel: single-zone settings, no business summary toggles.
  await panels.press('\t'); await panels.wait(() => panels.live() === 1 && panels.active().includes('Display'));
  const displayFrame = panels.frame();
  assert.match(displayFrame[0]!, /Display/);
  assert.match(displayFrame.join('\n'), /图标风格/);
  assert.match(displayFrame.join('\n'), /语言/);
  assert.match(displayFrame.join('\n'), /模型名最大宽度/);
  assert.doesNotMatch(displayFrame.join('\n'), /显示摘要/);
  assert.equal(displayFrame.filter(line => /^─+$/.test(line)).length, 3, 'Display is single-zone');
  await tab('\t', 'Todos', 0);
  await panels.press('h'); await panels.press('/'); await panels.press('Nested'); await tab('\t', 'Plan', 2);
  await tab('\x1b[Z', 'Todos', 0); assert.match(panels.frame().join('\n'), /搜索：Nested/);
  const paints = panels.forces.length, forced = panels.forces.filter(Boolean).length;
  await panels.press('\x1b[B'); await panels.press('\x1b[A');
  assert.equal(panels.forces.length, paints, 'key handling never requests a redraw');
  assert.ok(forced >= panels.mounts(), 'inline (re)anchoring is the only source of forced redraws');
  await panels.press('\x1b'); await panels.press('\x1b'); await pending; assert.equal(panels.live(), 0);
});
test('U7 production secondary statistics stay muted while switches infer their states', async t => {
  const h = await retryHost(t, ['goal', 'retry']);
  const styles: { text: string; fg: string }[] = [];
  h.ctx.mode = 'tui'; h.ctx.ui.theme = { style(text: string, options: { fg: string }) { styles.push({ text, fg: options.fg }); return text; } };
  await h.commands.get('retry').handler('when-error 5m,10m count 3', h.ctx);
  await h.call('goal', { action: 'create', title: 'Tone statistics', maxTurns: 7 });
  const panels = recordPanels(h.ctx);
  let opening = h.commands.get('retry').handler('', h.ctx);
  await panels.wait(() => panels.live() === 1); panels.frame();
  assert.ok(styles.some(style => style.text === '5m, 10m' && style.fg === 'muted'));
  assert.ok(styles.some(style => style.text === '3' && style.fg === 'muted'));
  assert.ok(styles.some(style => style.text === '开启' && style.fg === 'accent'));
  await panels.press('\x1b'); await opening; styles.length = 0;
  opening = h.commands.get('goal').handler('', h.ctx);
  await panels.wait(() => panels.live() === 1); panels.frame();
  for (const value of ['0/7', '0/5', '7']) assert.ok(styles.some(style => style.text === value && style.fg === 'muted'), value);
  // The per-goal switches live inside the goal now, so the root carries only statistics: an inactive
  // goal must never paint an accent "活动" claim, and the off switch tone (dim) is inferred by valueToneFor.
  assert.equal(styles.some(style => style.text === '活动' && style.fg === 'accent'), false, 'a paused goal is not painted as active');
  assert.equal(valueToneFor('关闭'), 'dim', 'an off switch value keeps the dim tone');
  await panels.press('\x1b'); await opening;
});

test('Goal panel deletion requires two Enter keys and never accepts an externally changed definition', async t => {
  const retry = await retryHost(t, ['todos', 'goal']);
  retry.ctx.mode = 'tui'; retry.ctx.ui.theme = { style: (text: string) => text };
  const panels = recordPanels(retry.ctx);
  await retry.call('goal', { action: 'create', title: 'Original goal', description: 'Original scope' });
  const state = () => retry.entries.findLast(entry => entry.customType === GOAL_TYPE)!.data;
  const opening = retry.commands.get('goal').handler('', retry.ctx);
  await panels.select('Original goal'); await panels.select('删除目标');
  assert.match(panels.frame().join('\n'), /删除 Goal #1：Original goal/); assert.notEqual(state().goals[0].status, 'deleted');
  await panels.press('x'); assert.doesNotMatch(panels.frame().join('\n'), /待确认/);
  await panels.press('\r'); await retry.call('goal', { action: 'update', id: 1, title: 'Changed goal' });
  await panels.press('\r'); assert.equal(state().goals[0].title, 'Changed goal'); assert.notEqual(state().goals[0].status, 'deleted');
  assert.doesNotMatch(panels.frame().join('\n'), /待确认/);
  await panels.select('删除目标'); assert.notEqual(state().goals[0].status, 'deleted');
  await panels.press('\r'); assert.equal(state().goals[0].status, 'deleted');
  await panels.press('\x1b'); await opening;
  assert.equal(retry.requests.filter(request => request.method === 'confirm').length, 0);
});
test('Retry widget separates standing by from retrying and names the real model', () => {
  const base = { enabled: true, phase: 'armed', attempts: 1, count: 4, intervals: '5m,30s', nextAt: 200_000 };
  const models = { enabled: true, current: 'test/alternative', candidates: [{ provider: 'test', id: 'alternative' }] };
  const zh = createTranslator('zh-CN'), en = createTranslator('en');
  assert.equal(retryWidgetLine(undefined, 18_000, zh), undefined);
  assert.equal(retryWidgetLine({ ...base, enabled: false }, 18_000, zh), undefined);
  // Standing by and retrying are different sentences, each with its own status glyph.
  const armed = retryWidgetLine(base, 18_000, zh)!, retrying = retryWidgetLine({ ...base, phase: 'waiting' }, 18_000, zh)!;
  assert.notEqual(armed, retrying, 'the two states read differently');
  assert.match(armed, new RegExp(String.fromCodePoint(0xf0565) + ' 待命'), 'standing by carries md-shield_check');
  assert.match(retrying, new RegExp(String.fromCodePoint(0xf04e6) + ' 重试中 1/4'), 'retrying carries md-sync and the attempt count');
  // Every field glyph is the table's: timer, current interval, counter, model.
  assert.ok(retrying.includes(String.fromCodePoint(0xf13ab) + ' 182s'), 'the countdown uses md-timer');
  assert.ok(retrying.includes(String.fromCodePoint(0xf0152) + ' 30s'), 'the current interval uses md-clock_fast');
  assert.ok(armed.includes(String.fromCodePoint(0xf0152) + ' 5m→30s'), 'the standing-by interval sequence uses md-clock_fast');
  assert.ok(armed.includes(String.fromCodePoint(0xf0199) + ' 4'), 'the limit uses md-counter');
  assert.ok(armed.includes(String.fromCodePoint(0xf06a9) + ' 默认'), 'the model uses md-robot');
  // Both modes keep the separators and the status bracket.
  for (const line of [armed, retrying]) {
    assert.ok(line.split(' · ').length >= 3, `segments survive: ${line}`);
    assert.match(line, /\[[^\]]+\]/, `the status stays bracketed: ${line}`);
  }
  // The model is the real provider/id, marked as a fallback when it is one of the candidates.
  const fallback = retryWidgetLine({ ...base, models }, 18_000, zh)!;
  assert.match(fallback, /openai|test\/alternative/, 'the real provider/id is shown');
  assert.match(fallback, /test\/alternative（替代）$/, 'a candidate model is marked as the fallback');
  assert.doesNotMatch(retryWidgetLine({ ...base, models: { ...models, current: 'test/default' } }, 18_000, zh)!, /（替代）/);
  // Plain mode: same skeleton, no private-use glyphs, words instead of field icons.
  const plain = retryWidgetLine({ ...base, models }, 18_000, zh, 'plain')!, plainRetrying = retryWidgetLine({ ...base, phase: 'waiting', models }, 18_000, zh, 'plain')!;
  assert.doesNotMatch(plain + plainRetrying, /[\u{f0000}-\u{ffffd}\ue000-\uf8ff]/u);
  assert.match(plain, /Retry \[待命\] · 5m→30s · 上限 4 · 模型 test\/alternative（替代）/);
  assert.match(plainRetrying, /Retry \[重试中 1\/4\] · 182s 后 · 间隔 30s · 模型 test\/alternative（替代）/);
  // The icon style switch really changes the output.
  assert.notEqual(retryWidgetLine(base, 18_000, zh), retryWidgetLine(base, 18_000, zh, 'plain'));
  // Unlimited count is spelled out, never "null".
  assert.match(retryWidgetLine({ ...base, count: null }, 18_000, zh)!, /不限/);
  assert.doesNotMatch(retryWidgetLine({ ...base, phase: 'running' }, 200_001, zh)!, /-\d|NaN|Infinity/);
  // English mirrors the same skeleton.
  assert.match(retryWidgetLine(base, 18_000, en)!, /Retry \[[^\]]*Standing by\] · /);
});

test('Retry widget sacrifices the model first and keeps the status and countdown when narrow', () => {
  // A neutral fixture id, assembled from parts: no private provider in a published test.
  const fixture = ['fixture', 'retry-sacrifice-model'].join('/');
  const base = { enabled: true, phase: 'waiting', attempts: 2, count: 5, intervals: '30s,2m,5m,15m', nextAt: 43_000, models: { enabled: true, current: fixture } };
  const at = (width: number) => retryWidgetLine(base, 20_000, createTranslator('zh-CN'), 'nerd-font', width)!;
  const wide = at(160), medium = at(46), narrow = at(30);
  assert.ok(wide.includes(fixture), 'the widest form keeps the whole model');
  assert.doesNotMatch(medium, /retry-sacrifice-model/, 'a narrower terminal drops the model');
  assert.match(medium, /\[[^\]]*重试中 2\/5\]/, 'the status bracket always survives');
  assert.match(medium, /23s/, 'the countdown always survives');
  assert.doesNotMatch(narrow, /30s/, 'the narrowest form drops the current interval too');
  assert.match(narrow, /\[[^\]]*重试中 2\/5\] · [^·]*23s/, 'status and countdown are the last two things to go');
  for (const width of [160, 46, 30]) assert.ok(visibleWidth(at(width)) <= width, `line fits ${width}`);
  // Standing by loses the interval sequence in the same order, keeping the limit.
  const armed = { ...base, phase: 'armed' };
  assert.doesNotMatch(retryWidgetLine(armed, 20_000, createTranslator('zh-CN'), 'nerd-font', 34)!, /30s→2m→5m→15m/);
  assert.match(retryWidgetLine(armed, 20_000, createTranslator('zh-CN'), 'nerd-font', 34)!, /\[[^\]]*待命\] · /);
});

}

// widget-hidden-plan.test.ts
{
test('restored standalone handoff survives /todos hide -> /plan start at nine terminal rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dag-widget-hidden-plan-'));
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  const events = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  let leaf = 1;
  let widget: any;
  const entries: any[] = [
    { type: 'custom', customType: STATE_TYPE, data: { ...emptyState(), nextId: 2, tasks: [{ id: 1, subject: 'Todo should stay hidden', status: 'pending', blockedBy: [] }] } },
    { type: 'custom', customType: 'pi-dag-workflow.agents', data: { version: 1, nextId: 2, jobs: [{
      id: 'a1', profile: 'fixture', model: { provider: 'fixture', id: 'offline' }, thinking: 'off', tools: ['read'],
      status: 'completed', startedAt: 1, endedAt: 2, pendingRequests: 0, reportDelivery: 'pending', output: 'ready to deliver', requests: [],
    }] } },
  ];
  const notifications: { text: string; type: string }[] = [];
  const pi: any = {
    on(name: string, fn: Function) { events.set(name, [...events.get(name) ?? [], fn]); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerFlag() {}, getFlag() {}, getActiveTools: () => ['read'], getAllTools: () => [...tools.values()],
    appendEntry(customType: string, data: any) { entries.push({ type: 'custom', customType, data }); leaf++; },
    sendMessage() { throw Error('unexpected wake'); }, sendUserMessage() { throw Error('unexpected model request'); },
  };
  const ctx: any = {
    mode: 'tui', hasUI: true, cwd: root, isIdle: () => true, modelRegistry: { find: () => undefined },
    sessionManager: { getBranch: () => [...entries], getLeafId: () => String(leaf), getSessionFile: () => undefined },
    ui: { theme: undefined, notify(text: string, type: string) { notifications.push({ text, type }); }, setWidget(_key: string, value: any) { widget = value; } },
  };
  const fire = async (name: string) => {
    const event = {};
    for (const fn of events.get(name) ?? []) await fn(event, ctx);
  };
  try {
    const workflow = createWorkflow(pi);
    for (const feature of ['todos', 'plan', 'agents', 'ui'] as const) await workflow.attach(feature, pi);
    await fire('session_start');
    await commands.get('todos').handler('hide', ctx);
    await commands.get('plan').handler('start', ctx);
    assert.ok(entries.findLast((entry) => entry.customType === PLAN_TYPE).data.enabled && !entries.findLast((entry) => entry.customType === STATE_TYPE).data.visible);
    assert.ok(!notifications.some((notification) => notification.type === 'error'), JSON.stringify(notifications));
    assert.equal(typeof widget, 'function');
    const terminal = { rows: 9 };
    const component = widget({ terminal });
    for (const rows of [9, 12, 24, 9]) {
      terminal.rows = rows;
      const lines: string[] = component.render(100);
      assert.ok(lines.length <= widgetHeightBudget(rows));
      assert.ok(lines.every((line) => visibleWidth(line) <= 100));
      assert.match(lines.join('\n'), /a1/);
      assert.match(lines.join('\n'), /待交付|Pending delivery/);
      assert.doesNotMatch(lines.join('\n'), /Todo should stay hidden/);
    }
  } finally {
    await fire('session_shutdown');
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    await rm(root, { recursive: true, force: true });
  }
});
}

// i18n rendering projections (formerly i18n.test.ts)
{
const en = createTranslator("en");
const hasHan = (text: string): boolean => /\p{Script=Han}/u.test(text);
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
const uiTasks: Todo[] = [
  { id: 1, subject: "Entry", status: "completed", blockedBy: [] },
  { id: 2, subject: "Research", status: "in_progress", blockedBy: [1], activeForm: "checking" },
  { id: 3, subject: "Implement", status: "pending", blockedBy: [1], owner: "User{0}\x1b[31m" },
  { id: 4, subject: "Verify", status: "pending", blockedBy: [2, 3] },
];
const uiState: WorkflowState = { ...emptyState(), tasks: uiTasks, nextId: 5, plan: true };
const uiJobs = [{ id: "a1", todoId: 2, profile: "fast", status: "running" as const, activity: { kind: "thinking" as const, since: Date.now() } }];

test("English renderTasks shows read-only, live agent activity, hidden rows and status words at every width", () => {
  for (const width of [20, 40, 80, 120]) {
    const lines = renderTasks(uiState, width, { maxRows: 3, jobs: uiJobs, msg: en });
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
      assert.doesNotMatch(line, /[\r\n]/);
    }
    assert.ok(!hasHan(lines.join("\n")), `unexpected Chinese at width ${width}: ${lines.join("\n")}`);
  }
  const wide = renderTasks(uiState, 80, { maxRows: 3, jobs: uiJobs, msg: en }).join("\n");
  assert.match(wide, /Plan \[read-only\]/);
  assert.match(wide, /Thinking/);
  assert.match(wide, /Main session/);
  assert.match(wide, /1 hidden/);
  const narrow = renderTasks(uiState, 20, { maxRows: 3, jobs: uiJobs, msg: en }).join("\n");
  assert.match(narrow, /1 hidden/);
  assert.doesNotMatch(narrow, /Plan \[read-only\]/);
  // Owner text is cleaned for display but its placeholder-looking content survives as data.
  assert.match(wide, /User\{0\}/);
  assert.equal(stripAnsi(wide), wide);
  assert.doesNotMatch(wide, /\x1b/);
});

test("English renderTasks keeps the three-block alignment and canonical chronological ids", () => {
  const lines = renderTasks(uiState, 120, { maxRows: Infinity, jobs: uiJobs, msg: en });
  const body = lines.filter((line) => /^[│ ]*[├└]─ /.test(stripAnsi(line)));
  assert.equal(body.length, 4);
  const iconColumn = (line: string): number => stripAnsi(line).search(/[✓○◐]/);
  const titleColumn = (line: string): number => {
    const plain = stripAnsi(line);
    const icon = plain.search(/[✓○◐]/);
    const after = plain.slice(icon + 1);
    return icon + 1 + (after.length - after.replace(/^ +/, "").length);
  };
  const icons = body.map(iconColumn);
  const titles = body.map(titleColumn);
  assert.ok(icons.every((value) => value === icons[0]));
  assert.ok(titles.every((value) => value === icons[0]! + 2));
  const ids = body.map((line) => Number(/#(\d+)/.exec(stripAnsi(line))![1]));
  assert.deepEqual(ids, [1, 2, 3, 4]);
});

test("English renderDag uses an explicit localized fallback and stays within narrow widths", () => {
  const fallback = renderDag(uiState, 40, undefined, undefined, [], { maxLines: 8, msg: en });
  for (const line of fallback) assert.ok(visibleWidth(line) <= 40, line);
  const text = fallback.join("\n");
  assert.match(text, /Graph degraded to a list: Parallel node/);
  assert.match(text, /#4<-#2,#3/);
  assert.ok(!hasHan(text));
  // A real solid graph is also localized at the header level.
  const graph = renderDag(uiState, 120, undefined, "中文目标", [], { msg: en });
  assert.match(graph.join("\n"), /Plan \[read-only\]/);
});

test("English dagLayout reasons and detail footer use the supplied translator", () => {
  const tiny = dagLayout(dagStructure([{ id: 1, status: "pending", blockedBy: [] }]), 10, en);
  assert.equal(tiny.layout, undefined);
  assert.equal(tiny.reason, "Insufficient width");
  const structure = dagStructure([{ id: 1, status: 'pending', blockedBy: [] }]);
  assert.equal(dagLayout(structure, 10, en).reason, 'Insufficient width');
  assert.equal(dagLayout(structure, 10, chinese).reason, '宽度不足');
  assert.equal(dagLayout(structure, 10, en).reason, 'Insufficient width');

});

}

// Agent projection cases moved unchanged from agents-integration.test.ts

{
const plain = (lines: string[]): string => lines.map(stripTerminalSequences).join('\n');
const task = (id: number, status: Todo['status'] = 'in_progress'): Todo => ({ id, subject: `任务${id}`, status, blockedBy: [] });
const state = (tasks: Todo[]): WorkflowState => ({ ...emptyState(), tasks, nextId: tasks.length + 1 });
const bound = (id: string, todoId: number, extra: Partial<AgentView> = {}): AgentView => ({ id, todoId, profile: 'worker', status: 'running', ...extra });
const dismissed = (id: string, todoId: number, status: AgentView['status'] = 'cancelled'): AgentView => ({ ...bound(id, todoId, { status }), taskReportStale: true, dismissed: true });
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// Explicit cancellation vs. an unhandled failure / explicit main takeover
// ---------------------------------------------------------------------------

test('an explicitly dismissed attempt shows the main session and a resumable hint in list, DAG, widget and pending filter', () => {
  const current = state([task(1)]);
  const attempt = dismissed('a1', 1);
  const msg = createTranslator('zh-CN');
  const ready = new RegExp(`\\[${escape(msg('可接续'))}\\]`);
  const texts = [
    renderTasks(current, 120, { jobs: [attempt], msg }),
    renderTasks(current, 120, { jobs: [attempt], msg, maxRows: Infinity, filter: 'pending' }),
    renderDag(current, 120, undefined, undefined, [attempt], { msg }),
    renderDag(current, 120, undefined, undefined, [attempt], { msg, maxLines: 12, filter: 'pending' }),
    renderWidget(current, 120, 14, { jobs: [attempt], msg }),
  ].map(plain);
  for (const text of texts) {
    assert.match(text, /\[主会话\]/);
    assert.match(text, ready);
    assert.doesNotMatch(text, /a1 · worker/);
  }
  assert.equal(filteredView(current.tasks, 'full', [attempt]).resumableIds.has(1), true);
});

test('an unhandled failure keeps the original job and error instead of a resumable hint', () => {
  const current = state([task(1)]);
  const failed = bound('a1', 1, { status: 'failed', reportDelivery: 'delivered' });
  const text = plain(renderTasks(current, 120, { jobs: [failed] }));
  assert.match(text, /a1 · worker/);
  assert.match(text, /失败/);
  assert.doesNotMatch(text, /可接续|主会话/);
  assert.equal(filteredView(current.tasks, 'full', [failed]).resumableIds.has(1), false);
});

test('an explicit main takeover of a plain failure stays on the normal main-session row', () => {
  const current = state([task(1)]);
  const staleFailed = { ...bound('a1', 1, { status: 'failed', reportDelivery: 'delivered' }), taskReportStale: true };
  const text = plain(renderTasks(current, 120, { jobs: [staleFailed] }));
  assert.match(text, /\[主会话\]/);
  assert.match(text, new RegExp(`\\[${escape(statusLabel.in_progress)}\\]`));
  assert.doesNotMatch(text, /可接续/);
});

// ---------------------------------------------------------------------------
// Attempt ordering and native acceptance precedence
// ---------------------------------------------------------------------------

test('a newer valid attempt outranks an older dismissed one', () => {
  const current = state([task(1)]);
  const older = dismissed('a1', 1);
  const fresh = bound('a2', 1, { status: 'running', taskReportStale: false });
  const text = plain(renderTasks(current, 120, { jobs: [older, fresh] }));
  assert.match(text, /a2 · worker/);
  assert.match(text, /运行中/);
  assert.doesNotMatch(text, /可接续/);
  const view = filteredView(current.tasks, 'full', [older, fresh]);
  assert.equal(view.resumableIds.has(1), false);
});

test('a native failed/cancelled/completed Todo is never made resumable by a dismissed attempt', () => {
  const attempt = dismissed('a1', 1);
  for (const status of ['failed', 'cancelled', 'completed'] as const) {
    const current = state([task(1, status)]);
    const text = plain(renderTasks(current, 120, { jobs: [attempt], maxRows: Infinity, filter: status }));
    assert.match(text, new RegExp(escape(statusLabel[status])));
    assert.doesNotMatch(text, /可接续/);
    assert.equal(filteredView(current.tasks, status, [attempt]).resumableIds.has(1), false);
  }
});

test('a dismissed cancellation keeps the Todo pending instead of turning it into a native cancellation', () => {
  const current = state([task(1)]);
  const attempt = dismissed('a1', 1, 'cancelled');
  const pending = filteredView(current.tasks, 'pending', [attempt]);
  assert.equal(pending.effective.get(1), 'pending');
  assert.equal(pending.resumableIds.has(1), true);
  assert.equal(filteredView(current.tasks, 'cancelled', [attempt]).effective.has(1), false);
});

// ---------------------------------------------------------------------------
// Standalone dismissal visibility
// ---------------------------------------------------------------------------

test('a dismissed standalone job is hidden in full but visible under explicit result filters', () => {
  const current = state([task(1, 'completed')]);
  for (const filter of ['failed', 'cancelled', 'completed'] as const) {
    const gone: AgentView = { id: 'a9', profile: 'worker', status: filter, dismissed: true, taskReportStale: true };
    assert.doesNotMatch(plain(renderTasks(current, 120, { jobs: [gone] })), /Standalone/, `${filter} hidden in full`);
    assert.equal(filteredView(current.tasks, 'full', [gone]).standaloneIds.has('a9'), false);
    assert.equal(filteredView(current.tasks, filter, [gone]).standaloneIds.has('a9'), true);
    const text = plain(renderTasks(current, 120, { jobs: [gone], filter }));
    assert.match(text, /Standalone/);
    assert.match(text, /a9/);
  }
  // A non-dismissed closed job still explains itself in the default full view.
  const open: AgentView = { id: 'a9', profile: 'worker', status: 'failed' };
  assert.match(plain(renderTasks(current, 120, { jobs: [open] })), /Standalone/);
});
}

{
const plain = (lines: string[]): string => lines.map(stripTerminalSequences).join('\n');
const task = (id: number, status: Todo['status'] = 'in_progress'): Todo => ({ id, subject: `任务${id}`, status, blockedBy: [] });
const state = (tasks: Todo[], treeStyle?: WorkflowState['treeStyle']): WorkflowState => ({ ...emptyState(), tasks, nextId: tasks.length + 1, ...(treeStyle ? { treeStyle } : {}) });
const bound = (id: string, todoId: number, extra: Partial<AgentView> = {}): AgentView => ({ id, todoId, profile: 'worker', status: 'running', ...extra });
const stale = (id: string, todoId: number, extra: Partial<AgentView> = {}): AgentView => bound(id, todoId, { taskReportStale: true, ...extra });
const dismissed = (id: string, todoId: number, status: AgentView['status'] = 'cancelled'): AgentView => stale(id, todoId, { status, dismissed: true });
const shownIds = (lines: string[]): number[] => lines.flatMap((line) => {
  const match = /[├└]─ #([0-9]+)/.exec(stripTerminalSequences(line));
  return match ? [Number(match[1])] : [];
});

// ---------------------------------------------------------------------------
// The projection rule: the newest bound attempt speaks, and a stale newest
// attempt silences the row instead of reviving an older failure.
// ---------------------------------------------------------------------------

test('latestBoundJobs takes the newest attempt and drops it when stale, never falling back', () => {
  const olderFailed = bound('a1', 1, { status: 'failed' });
  const newerStaleFailed = stale('a2', 1, { status: 'failed' });
  const latest = latestBoundJobs([olderFailed, newerStaleFailed]);
  assert.equal(latest.get(1), undefined, 'a stale newer attempt wins and then removes the entry');
  assert.equal(taskFilterStatus(task(1), latest.get(1)), 'pending');

  // Runtime order decides: the last bound job is the newest, whatever its staleness.
  assert.equal(latestBoundJobs([newerStaleFailed, olderFailed]).get(1)!.id, 'a1');
  // A stale-only Todo has no speaking attempt.
  assert.equal(latestBoundJobs([stale('a9', 9, { status: 'failed' })]).get(9), undefined);
  // Unbound jobs never enter the map, and older stale attempts do not leak through.
  const unbound: AgentView = { id: 'a1', profile: 'worker', status: 'failed' };
  assert.equal(latestBoundJobs([unbound]).size, 0);
  assert.equal(latestBoundJobs([stale('a1', 1), stale('a2', 1)]).size, 0);
});

test('an older failed attempt cannot report through a newer dismissed attempt in any view or filter', () => {
  const current = state([task(1)]);
  const jobs = [bound('a1', 1, { status: 'failed', reportDelivery: 'delivered' }), dismissed('a2', 1, 'cancelled')];
  const view = filteredView(current.tasks, 'full', jobs);
  assert.equal(view.effective.get(1), 'pending', 'the stale newer attempt keeps the row pending');
  assert.equal(view.resumableIds.has(1), true, 'the dismissed newest attempt makes the row resumable');
  assert.equal(latestBoundJobs(jobs).get(1), undefined);

  for (const style of ['paths', 'flat'] as const) {
    const panel = state([task(1)], style);
    const full = plain(renderTasks(panel, 120, { jobs, maxRows: Infinity }));
    assert.match(full, /\[主会话\]/, `${style} full keeps the main-session row`);
    assert.match(full, /\[可接续\]/, `${style} full offers resume`);
    assert.doesNotMatch(full, /a1 · worker|失败/, `${style} full never revives the old failure`);

    const failed = plain(renderTasks(panel, 120, { jobs, maxRows: Infinity, filter: 'failed' }));
    assert.deepEqual(shownIds(failed.split('\n')), [], `${style} failed filter hides the row`);
    const pending = plain(renderTasks(panel, 120, { jobs, maxRows: Infinity, filter: 'pending' }));
    assert.deepEqual(shownIds(pending.split('\n')), [1], `${style} pending filter keeps the row`);
    assert.match(pending, /\[可接续\]/);
    const cancelled = plain(renderTasks(panel, 120, { jobs, maxRows: Infinity, filter: 'cancelled' }));
    assert.deepEqual(shownIds(cancelled.split('\n')), [], `${style} cancelled filter hides the row`);
    const completed = plain(renderTasks(panel, 120, { jobs, maxRows: Infinity, filter: 'completed' }));
    assert.deepEqual(shownIds(completed.split('\n')), [], `${style} completed filter hides the row`);
  }

  const dag = plain(renderDag(current, 120, undefined, undefined, jobs, { maxLines: Infinity }));
  assert.match(dag, /\[主会话\]/);
  assert.match(dag, /\[可接续\]/);
  assert.doesNotMatch(dag, /失败/);
  const dagFailed = plain(renderDag(current, 120, undefined, undefined, jobs, { maxLines: Infinity, filter: 'failed' }));
  assert.doesNotMatch(dagFailed, /#1\b.*失败/s);

  const widget = plain(renderWidget(current, 120, 20, { jobs }));
  assert.match(widget, /\[主会话\]/);
  assert.match(widget, /\[可接续\]/);
  assert.doesNotMatch(widget, /失败/);
});

test('a main takeover (stale but not dismissed) stays a plain pending row without a resume hint', () => {
  const current = state([task(1)]);
  const jobs = [bound('a1', 1, { status: 'failed', reportDelivery: 'delivered' }), stale('a2', 1, { status: 'failed' })];
  const view = filteredView(current.tasks, 'full', jobs);
  assert.equal(view.effective.get(1), 'pending');
  assert.equal(view.resumableIds.has(1), false);
  assert.equal(latestBoundJobs(jobs).get(1), undefined);
  for (const style of ['paths', 'flat'] as const) {
    const text = plain(renderTasks(state([task(1)], style), 120, { jobs, maxRows: Infinity }));
    assert.match(text, /\[主会话\]/, `${style} main session owns the row`);
    assert.match(text, new RegExp(`\\[${statusLabel.in_progress}\\]`), `${style} keeps the canonical state`);
    assert.doesNotMatch(text, /可接续|a1 · worker|失败/, `${style} no resume and no stale failure`);
  }
});

test('a newer live attempt outranks an older failure and needs no resume', () => {
  const current = state([task(1)]);
  const jobs = [bound('a1', 1, { status: 'failed' }), bound('a2', 1, { status: 'running' })];
  assert.equal(filteredView(current.tasks, 'full', jobs).effective.get(1), 'pending');
  assert.equal(filteredView(current.tasks, 'full', jobs).resumableIds.has(1), false);
  assert.equal(latestBoundJobs(jobs).get(1)!.id, 'a2');
  const text = plain(renderTasks(current, 120, { jobs, maxRows: Infinity }));
  assert.match(text, /a2 · worker/);
  assert.doesNotMatch(text, /失败/);
});

test('the newest non-dismissed cancellation decides the cancelled filter; dismissal turns it back to pending', () => {
  const current = state([task(1)]);
  const cancelled = [bound('a1', 1, { status: 'cancelled' })];
  assert.equal(filteredView(current.tasks, 'cancelled', cancelled).effective.get(1), 'cancelled');
  assert.deepEqual(shownIds(renderTasks(current, 120, { jobs: cancelled, maxRows: Infinity, filter: 'cancelled' }).map(stripTerminalSequences)), [1]);
  assert.deepEqual(shownIds(renderTasks(current, 120, { jobs: cancelled, maxRows: Infinity, filter: 'pending' }).map(stripTerminalSequences)), []);

  // The same cancellation, now explicitly dismissed, is pending work with a resume hint.
  const dismissedCancel = [bound('a1', 1, { status: 'failed' }), dismissed('a2', 1, 'cancelled')];
  assert.equal(filteredView(current.tasks, 'cancelled', dismissedCancel).effective.has(1), false);
  assert.equal(filteredView(current.tasks, 'cancelled', dismissedCancel).resumableIds.has(1), true);
});

test('native terminal Todo states outrank any attempt and are never made resumable', () => {
  for (const status of ['failed', 'cancelled', 'completed'] as const) {
    const current = state([task(1, status)]);
    const jobs = [bound('a1', 1, { status: 'failed' }), dismissed('a2', 1, 'cancelled')];
    assert.equal(filteredView(current.tasks, status, jobs).effective.get(1), status);
    assert.equal(filteredView(current.tasks, status, jobs).resumableIds.has(1), false);
    assert.equal(taskFilterStatus(task(1, status), latestBoundJobs(jobs).get(1)), status);
    for (const filter of ['full', 'pending', 'completed', 'failed', 'cancelled'] as const) {
      const ids = shownIds(renderTasks(current, 120, { jobs, maxRows: Infinity, filter }).map(stripTerminalSequences));
      const expected = filter === 'full' || filter === status ? [1] : [];
      assert.deepEqual(ids, expected, `${status} under ${filter}`);
    }
  }
});

test('a dismissed newest attempt of any terminal status keeps the row pending and resumable', () => {
  const current = state([task(1)]);
  for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
    const jobs = [bound('a1', 1, { status: 'failed' }), dismissed('a2', 1, status)];
    const view = filteredView(current.tasks, 'full', jobs);
    assert.equal(view.effective.get(1), 'pending', `${status}: newest dismissal is pending`);
    assert.equal(view.resumableIds.has(1), true, `${status}: newest dismissal is resumable`);
    for (const filter of ['failed', 'cancelled'] as const) {
      assert.equal(filteredView(current.tasks, filter, jobs).effective.has(1), false, `${status} hidden from ${filter}`);
    }
  }
});

test('a pending-delivery success stays pending work and never becomes resumable', () => {
  const current = state([task(1)]);
  const jobs = [bound('a1', 1, { status: 'completed', reportDelivery: 'pending' })];
  const view = filteredView(current.tasks, 'full', jobs);
  assert.equal(view.effective.get(1), 'pending');
  assert.equal(view.resumableIds.has(1), false);
  assert.equal(latestBoundJobs(jobs).get(1)!.id, 'a1');
  const pending = plain(renderTasks(current, 120, { jobs, maxRows: Infinity, filter: 'pending' }));
  assert.deepEqual(shownIds(pending.split('\n')), [1]);
  assert.match(pending, /待交付/);
  assert.doesNotMatch(pending, /可接续/);
  assert.deepEqual(shownIds(renderTasks(current, 120, { jobs, maxRows: Infinity, filter: 'completed' }).map(stripTerminalSequences)), [], 'delivery still waits before the completed filter');
});

// ---------------------------------------------------------------------------
// Standalone dismissal + legacy stale jobs stay compatible.
// ---------------------------------------------------------------------------

test('dismissed standalone history hides in full, stays in result filters and leaves pending alone', () => {
  const current = state([task(1, 'completed')]);
  for (const filter of ['failed', 'cancelled', 'completed'] as const) {
    const gone: AgentView = { id: 'a9', profile: 'worker', status: filter, dismissed: true, taskReportStale: true };
    assert.equal(filteredView(current.tasks, 'full', [gone]).standaloneIds.has('a9'), false);
    assert.equal(filteredView(current.tasks, filter, [gone]).standaloneIds.has('a9'), true);
    assert.equal(filteredView(current.tasks, 'pending', [gone]).standaloneIds.has('a9'), false);
    assert.match(plain(renderTasks(current, 120, { jobs: [gone], filter })), /a9/);
    assert.doesNotMatch(plain(renderTasks(current, 120, { jobs: [gone] })), /a9/);
  }
  // A pending-delivery success is unfinished work even if the terminal filter would list it.
  const delivery: AgentView = { id: 'a8', profile: 'worker', status: 'completed', reportDelivery: 'pending' };
  assert.equal(filteredView(current.tasks, 'full', [delivery]).standaloneIds.has('a8'), true);
  assert.equal(filteredView(current.tasks, 'pending', [delivery]).standaloneIds.has('a8'), true);
});

test('legacy stale job records without a dismissal marker project cleanly instead of erroring', () => {
  const current = state([task(1), task(2, 'in_progress')]);
  // Legacy persisted shape: only the stale flag plus an unknown Todo id, no dismissed field.
  const legacy = [
    { id: 'old1', todoId: 1, profile: 'worker', status: 'failed', taskReportStale: true } as AgentView,
    { id: 'old2', todoId: 99, profile: 'worker', status: 'failed', taskReportStale: true } as AgentView,
    { id: 'old3', todoId: 2, profile: 'worker', status: 'running' } as AgentView,
  ];
  const latest = latestBoundJobs(legacy);
  assert.equal(latest.get(1), undefined);
  assert.equal(latest.get(99), undefined);
  assert.equal(latest.get(2)!.id, 'old3');
  const view = filteredView(current.tasks, 'full', legacy);
  assert.equal(view.effective.get(1), 'pending');
  assert.equal(view.effective.get(2), 'pending');
  assert.equal(view.resumableIds.size, 0);
  assert.doesNotThrow(() => renderTasks(current, 120, { jobs: legacy, maxRows: Infinity }));
  assert.doesNotThrow(() => renderDag(current, 120, undefined, undefined, legacy));
  assert.doesNotThrow(() => renderWidget(current, 120, 16, { jobs: legacy }));
});
}

{
const task = (id: number, subject = "实现解析器"): Todo => ({ id, subject, status: "in_progress", blockedBy: [] });
const base = { ...emptyState(), tasks: [task(1)], nextId: 2 };
const job = (activity?: AgentView["activity"], status: AgentView["status"] = "running"): AgentView => ({ id: "a1", todoId: 1, profile: "coding", status, ...(activity ? { activity } : {}) });
const lines = (jobs: readonly AgentView[], width = 80) => renderTasks(base, width, { jobs, maxRows: Infinity }).map(stripTerminalSequences).join("\n");

test("live activity replaces the coarse running label with the child's real current action", () => {
  assert.match(lines([job({ kind: "thinking", since: Date.now() - 4000 })]), /󰧑 思考中/);
  assert.match(lines([job({ kind: "output", since: Date.now() })]), /󰏫 输出中/);
  assert.match(lines([job({ kind: "tool", tool: "bash", since: Date.now() - 3000 })]), /󰆍 bash 3s/);
  assert.doesNotMatch(lines([job({ kind: "tool", tool: "bash", since: Date.now() - 3000 })]), /运行中/);
});

test("tool names are shortened and capped at ten columns while the elapsed time stays uncapped", () => {
  assert.match(lines([job({ kind: "tool", tool: "mcp__github__list_repository_files", since: Date.now() - 200000 })]), /󰆍 list_repo… 3m20s/);
  assert.match(lines([job({ kind: "tool", tool: "read", since: Date.now() - 500 })]), /󰆍 read/);
});

test("stable statuses never show live activity and restore never fakes one", () => {
  assert.match(lines([job(undefined, "completed")]), /󰥔 待核验/);
  assert.match(lines([job(undefined, "waiting")]), /󰋗 等待回复/);
  assert.match(lines([job(undefined, "interrupted")]), /󰙦 已中断/);
  assert.match(lines([job(undefined, "failed")]), /󰅙 失败/);
  assert.match(lines([job(undefined, "cancelled")]), /󰓛 已取消/);
  assert.match(lines([job(undefined, "starting")]), /󰓦 启动中/);
  assert.match(lines([job({ kind: "thinking" }, "waiting")]), /󰋗 等待回复/);
  assert.doesNotMatch(lines([job({ kind: "thinking" }, "waiting")]), /思考/);
});

test("narrow widths drop the tool detail before the owner column", () => {
  const wide = lines([job({ kind: "tool", tool: "list_repository_files", since: Date.now() - 3000 })], 60);
  assert.match(wide, /a1 · coding/);
  const narrow = lines([job({ kind: "tool", tool: "list_repository_files", since: Date.now() - 3000 })], 34);
  assert.match(narrow, /\[a1 · coding\] \[󰆍\]/);
  assert.doesNotMatch(narrow, /3s|list_repository|已返回/);
  assert.match(narrow, /#1/);
});
}

// Pure fragment brief projection, moved unchanged from agents-integration.test.ts

{
const step = (id: number, key: string, subject: string, status: Todo["status"], position: number, run = 1): Todo => ({ id, subject, status, blockedBy: [], metadata: { preset: "browser-check", run, key, step: position } });

test("a fragment brief names the step, lists the whole fragment and heads of earlier reports", () => {
  const tasks = [
    step(1, "bridge", "确认桥接在线", "completed", 1),
    step(2, "open", "打开页面", "in_progress", 2),
    step(3, "report", "报告截图", "pending", 3),
    { id: 9, subject: "无关任务", status: "completed" as const, blockedBy: [] },
  ];
  const brief = fragmentContext(2, tasks, [{ todoId: 1, status: "completed", output: "  connected: true\n标签页 8 个  " + "长".repeat(260) }])!;
  assert.match(brief, /Task fragment browser-check run 1, step 2 of 3: you took open "打开页面" \(running\)\./);
  assert.match(brief, /Whole fragment: bridge "确认桥接在线" \[done\]; open "打开页面" \[running\]; report "报告截图" \[pending\]\./);
  assert.match(brief, /Earlier and prerequisite steps of this fragment, report heads:\n- bridge \(done\): connected: true 标签页 8 个 长/);
  assert.match(brief, /…/);
  assert.match(brief, /Steps that still depend on others stay for the parent to dispatch/);
  assert.equal(brief.length <= 2000, true);
  // Only a fragment task gets a brief, another instance never leaks in, and unrelated tasks never appear.
  assert.equal(fragmentContext(9, tasks, []), undefined);
  assert.equal(fragmentContext(4, tasks, []), undefined);
  assert.doesNotMatch(fragmentContext(1, tasks, [])!, /无关任务/);
});

test("a later run only briefs its own instance and keeps step numbering per run", () => {
  const tasks = [step(1, "bridge", "第一轮", "completed", 1, 1), step(4, "bridge", "第二轮", "in_progress", 1, 2), step(5, "open", "第二轮第二步", "pending", 2, 2)];
  const brief = fragmentContext(4, tasks, [])!;
  assert.match(brief, /run 2, step 1 of 2/);
  assert.match(brief, /第二轮/);
  assert.doesNotMatch(brief, /第一轮/);
});

test("a redispatched prerequisite contributes its latest report instead of a failed attempt", () => {
  const tasks = [step(1, "first", "First", "completed", 1), step(2, "second", "Second", "pending", 2)];
  const brief = fragmentContext(2, tasks, [
    { todoId: 1, status: "failed", output: "obsolete partial output" },
    { todoId: 1, status: "completed", output: "verified replacement result" },
  ])!;
  assert.match(brief, /verified replacement result/);
  assert.doesNotMatch(brief, /obsolete partial/);
});

test("failed and cancelled steps read as themselves, never as pending", () => {
  const tasks = [
    step(1, "a", "甲", "failed", 1),
    step(2, "b", "乙", "cancelled", 2),
    step(3, "c", "丙", "in_progress", 3),
    step(4, "d", "丁", "pending", 4),
  ];
  const brief = fragmentContext(3, tasks, [])!;
  assert.match(brief, /Whole fragment: a "甲" \[failed\]; b "乙" \[cancelled\]; c "丙" \[running\]; d "丁" \[pending\]\./);
  assert.match(brief, /you took c "丙" \(running\)\./);
});

test("a stale or failed latest report is never replaced by an older one", () => {
  const tasks = [step(1, "first", "First", "completed", 1), step(2, "second", "Second", "pending", 2)];
  const stale = fragmentContext(2, tasks, [
    { todoId: 1, status: "completed", output: "ancient verified result" },
    { todoId: 1, status: "completed", output: "reopened attempt kept around", taskReportStale: true },
  ])!;
  assert.doesNotMatch(stale, /ancient verified result|reopened attempt kept around/);
  assert.doesNotMatch(stale, /report heads/);
  const failed = fragmentContext(2, tasks, [
    { todoId: 1, status: "completed", output: "old good result" },
    { todoId: 1, status: "failed", output: "second attempt failed" },
  ])!;
  assert.doesNotMatch(failed, /old good result|second attempt failed/);
  assert.doesNotMatch(failed, /report heads/);
});

test("a forward prerequisite above the current id still contributes its result", () => {
  const tasks: Todo[] = [
    { id: 2, subject: "检查", status: "in_progress", blockedBy: [5], metadata: { preset: "browser-check", run: 1, key: "check", step: 1 } },
    { id: 5, subject: "上游", status: "completed", blockedBy: [], metadata: { preset: "browser-check", run: 1, key: "upstream", step: 2 } },
  ];
  const brief = fragmentContext(2, tasks, [{ todoId: 5, status: "completed", output: "upstream evidence" }])!;
  assert.match(brief, /- upstream \(done\): upstream evidence/);
});

test("a prerequisite outside this run is never pulled in from another instance", () => {
  const tasks: Todo[] = [
    { id: 1, subject: "旧轮", status: "completed", blockedBy: [], metadata: { preset: "browser-check", run: 1, key: "old", step: 1 } },
    { id: 6, subject: "本轮", status: "in_progress", blockedBy: [1], metadata: { preset: "browser-check", run: 2, key: "now", step: 1 } },
  ];
  const brief = fragmentContext(6, tasks, [{ todoId: 1, status: "completed", output: "from another run" }])!;
  assert.doesNotMatch(brief, /from another run|旧轮/);
});

test("long fragment titles cannot crowd out the current step's instructions", () => {
  const title = "很长的标题".repeat(20);
  const tasks: Todo[] = [];
  for (let id = 1; id <= 12; id++) tasks.push(step(id, `k${id}`, title, "pending", id));
  const instructions = "按顺序完成本步骤的详细指示：" + "细节".repeat(200);
  tasks[5] = { ...tasks[5]!, description: instructions };
  const brief = fragmentContext(6, tasks, [])!;
  assert.equal(brief.length <= 2000, true);
  assert.match(brief, /This step's instructions: 按顺序完成本步骤的详细指示/);
  const at = brief.indexOf("This step's instructions: ");
  assert.equal(brief.slice(at).length > 400, true);
});

test('redirected report heads use the current output offset, not retained historical output', () => {
  const tasks = [step(1, 'first', 'First', 'completed', 1), step(2, 'second', 'Second', 'pending', 2)];
  const history = 'old assignment failed\n';
  const brief = fragmentContext(2, tasks, [{ todoId: 1, status: 'completed', output: `${history}verified new evidence`, outputStart: history.length }])!;
  assert.match(brief, /verified new evidence/); assert.doesNotMatch(brief, /old assignment failed/);
  assert.doesNotMatch(fragmentContext(2, tasks, [{ todoId: 1, status: 'interrupted', output: 'unfinished old work' }])!, /unfinished old work/);
});

test('maximum-length current titles and fragment lists retain both instructions and prerequisite evidence', () => {
  const tasks = Array.from({ length: 32 }, (_, i) => step(i + 1, `k${i}`, '长'.repeat(8000), 'completed', i + 1));
  tasks[31] = { ...tasks[31]!, status: 'in_progress', blockedBy: [1], description: 'CRITICAL-CURRENT-INSTRUCTION ' + '细节'.repeat(1000) };
  const brief = fragmentContext(32, tasks, [{ todoId: 1, status: 'completed', output: 'VERIFIED-PREREQUISITE ' + '𐐀'.repeat(200) }])!;
  assert.match(brief, /CRITICAL-CURRENT-INSTRUCTION/); assert.match(brief, /VERIFIED-PREREQUISITE/); assert.ok(brief.length <= 2000);
  assert.doesNotMatch(brief, /[\uD800-\uDFFF]/u, 'no lone surrogate survives truncation');
});

test('a tight report budget never skips a direct prerequisite to include a lower-priority short report', () => {
  const tasks = [step(1, 'earlier', 'earlier', 'completed', 1), step(2, 'directA', 'direct A', 'completed', 2), step(3, 'directB', 'direct B', 'completed', 3), { ...step(4, 'current', 'current', 'in_progress', 4), blockedBy: [2, 3], description: 'instructions '.repeat(400) }];
  const brief = fragmentContext(4, tasks, [{ todoId: 1, status: 'completed', output: 'LOW-PRIORITY' }, { todoId: 2, status: 'completed', output: 'DIRECT-A ' + 'a'.repeat(250) }, { todoId: 3, status: 'completed', output: 'DIRECT-B ' + 'b'.repeat(250) }])!;
  assert.match(brief, /DIRECT-A/); assert.doesNotMatch(brief, /LOW-PRIORITY/);
});

}

// Pure configuration presentation from agents-protocol.test.ts.
{
const catalogModel=(provider:string,id:string)=>({provider,id,name:`Name ${id}`,reasoning:true,contextWindow:10000,maxTokens:1000,input:['text'],baseUrl:'https://private.invalid',headers:{Authorization:'SECRET'},apiKey:'SECRET'});
test('job, spawn and model catalog presentations include only selected configuration in both languages', () => {
  for (const locale of ['zh-CN', 'en'] as const) {
    const msg = createTranslator(locale);
    const configuration = { model: { provider: 'test', id: 'actual' }, thinking: 'low', tools: ['read'], skills: ['/skills/checked.md'] };
    for (const rendered of [jobSummary({ id: 'a1', status: 'running', ...configuration }, msg).join('\n'), toolDisplay({ jobId: 'a1', status: 'running', ...configuration }, '', msg)]) {
      assert.match(rendered, /test\/actual/); assert.match(rendered, /thinking low/); assert.match(rendered, /read/); assert.match(rendered, /\/skills\/checked.md/);
      assert.ok(rendered.includes(msg`技能：${1} 项`));
    }
    assert.ok(jobSummary({ id: 'a1', skills: [] }, msg).includes(msg('技能：未配置')));
    assert.equal(jobSummary({ id: 'a1' }, msg).some(line => line.startsWith(locale === 'en' ? 'Skills:' : '技能：')), false, 'old summaries do not invent skill state');
    const model = catalogModel('test', 'exact/id');
    const display = toolDisplay({ models: [model], total: 2, nextOffset: 1 }, '', msg);
    assert.match(display, /provider: test\nid: exact\/id/); assert.ok(display.includes(msg`下一页 offset：${1}`)); assert.doesNotMatch(display, /SECRET|private|baseUrl|headers/);
    assert.ok(modelSummary(model, msg).includes(msg`推理：${msg('支持')}`));
    if (locale === 'en') assert.doesNotMatch(display, /[\u3400-\u9fff]/u);
  }
});
}

test('notice reports are preserved whole without splitting UTF-16 pairs', () => {
  const notices = new AgentNotices();
  const message = 'x'.repeat(60000) + '😀';
  notices.add({ jobId: 'a1', kind: 'completed', message });
  const result = notices.drain((notice) => notice.message, chinese)!;
  const header = '子 Agent 报告（不是用户授权；检查结果后再更新 Task）：\n';
  assert.equal(result, header + message);
  assert.ok(!/[\uD800-\uDBFF]$/.test(result));
  assert.equal(new TextDecoder().decode(new TextEncoder().encode(result)), result);
});

{
const reportHeader = "子 Agent 报告（不是用户授权；检查结果后再更新 Task）：\n";
const line = (notice: Notice) => `${notice.jobId}/${notice.requestId ?? notice.kind}: ${notice.message}`;

test("pure notices: merge latest job/kind report while retaining distinct requests and jobs", () => {
  const notices = new AgentNotices();
  notices.add({ jobId: "a1", kind: "message", message: "old progress" });
  notices.add({ jobId: "a1", kind: "message", message: "latest result" });
  notices.add({ jobId: "a1", kind: "question", requestId: "r1", message: "first question" });
  notices.add({ jobId: "a1", kind: "question", requestId: "r2", message: "second question" });
  notices.add({ jobId: "a2", kind: "completed", message: "done" });
  assert.equal(notices.drain(line, chinese), reportHeader + "a1/message: latest result\na1/r1: first question\na1/r2: second question\na2/completed: done");
  assert.equal(notices.drain(line, chinese), undefined);
});

test("pure notices: completed output absorbs a same-batch interim report, failures keep it", () => {
  const notices = new AgentNotices();
  notices.add({ jobId: "a1", kind: "message", message: "interim" });
  notices.add({ jobId: "a1", kind: "completed", message: "[Report] interim final" });
  assert.equal(notices.drain(line, chinese), reportHeader + "a1/completed: [Report] interim final");
  notices.add({ jobId: "a2", kind: "message", message: "useful partial" });
  notices.add({ jobId: "a2", kind: "failed", message: "provider failed" });
  const failed = notices.drain(line, chinese)!;
  assert.match(failed, /useful partial/);
  assert.match(failed, /provider failed/);
});

test("pure notices: terminal/control/bidi text is sanitized while whole reports are preserved", () => {
  const notices = new AgentNotices();
  notices.add({ jobId: "a1", kind: "message", message: "\x1b[31mred\x1b[0m\n\tline\r\u202e\0\x1b]52;c;ZXZpbA==\x07" });
  const long = "x".repeat(60000) + "😀";
  notices.add({ jobId: "a2", kind: "failed", message: long });
  const seen: Notice[] = [];
  const report = notices.drain((notice) => { seen.push(notice); return line(notice); }, chinese);
  assert.equal(seen[0]!.message, "red line");
  assert.equal(seen[1]!.message, long);
  assert.ok(!/[\uD800-\uDBFF]$/.test(seen[1]!.message));
  assert.doesNotMatch(report!, /[\x1b\0\u202e]|ZXZpbA/);
});

test("pure notices: retain at most 32 reports, preferring questions over normal reports", () => {
  const notices = new AgentNotices();
  notices.add({ jobId: "question", kind: "question", requestId: "r1", message: "keep me" });
  for (let i = 0; i < 40; i++) notices.add({ jobId: `a${i}`, kind: "completed", message: String(i) });
  const seen: Notice[] = [];
  notices.drain((notice) => { seen.push(notice); return notice.message; }, chinese);
  assert.equal(seen.length, 32);
  assert.equal(seen[0]!.kind, "question");
  assert.deepEqual(seen.slice(1).map((notice) => notice.jobId), Array.from({ length: 31 }, (_, i) => `a${i + 9}`));
});

test("pure notices: question overflow remains bounded and drops the oldest question", () => {
  const notices = new AgentNotices();
  for (let i = 0; i < 33; i++) notices.add({ jobId: "a1", kind: "question", requestId: `r${i}`, message: String(i) });
  const seen: Notice[] = [];
  notices.drain((notice) => { seen.push(notice); return notice.message; }, chinese);
  assert.equal(seen.length, 32);
  assert.equal(seen[0]!.requestId, "r1");
  assert.equal(seen.at(-1)!.requestId, "r32");
});

test("pure notices: drop removes all reports for one job, filter removes obsolete jobs, clear is idempotent", () => {
  const notices = new AgentNotices();
  notices.add({ jobId: "a1", kind: "message", message: "removed" });
  notices.add({ jobId: "a1", kind: "question", requestId: "r1", message: "removed question" });
  notices.add({ jobId: "a2", kind: "completed", message: "obsolete" });
  notices.add({ jobId: "a3", kind: "completed", message: "keep" });
  notices.drop("a1");
  notices.drop("missing");
  assert.equal(notices.drain((notice) => notice.jobId === "a2" ? undefined : line(notice), chinese), reportHeader + "a3/completed: keep");
  assert.equal(notices.drain(line, chinese), undefined);
  notices.add({ jobId: "a4", kind: "failed", message: "discard" });
  notices.clear();
  notices.clear();
  assert.equal(notices.drain(line, chinese), undefined);
});

test('pure notices: consuming an older report version never discards a newer report or question', () => {
  const notices = new AgentNotices();
  notices.add({ jobId: 'a1', kind: 'message', message: 'old', version: 1 });
  notices.add({ jobId: 'a1', kind: 'message', message: 'new', version: 2 });
  notices.add({ jobId: 'a1', kind: 'question', message: 'new question', requestId: 'q2', version: 2 });
  notices.drop('a1', 1);
  const delivered = notices.drain((item) => item.message, chinese)!;
  assert.match(delivered, /new/); assert.match(delivered, /new question/); assert.doesNotMatch(delivered, /old/);
});

test("pure notices: a merged batch keeps every character beyond the old 16000 budget", () => {
  const notices = new AgentNotices();
  for (let i = 0; i < 32; i++) notices.add({ jobId: `a${i}`, kind: "completed", message: "x".repeat(50000) });
  let calls = 0;
  const report = notices.drain((notice) => { calls++; return notice.message; }, chinese)!;
  const payload = report.slice(reportHeader.length);
  assert.equal(calls, 32);
  assert.equal(report.length, reportHeader.length + 32 * 50000 + 31);
  assert.equal(payload.length, 32 * 50000 + 31);
  assert.equal(notices.drain(line, chinese), undefined, "delivered reports are not replayed");
});
}

{
const msg = createTranslator('zh-CN');
const task = (id: number, status: Todo['status'] = 'in_progress'): Todo => ({ id, subject: `任务${id}`, status, blockedBy: [] });
const state = (tasks: Todo[]): WorkflowState => ({ ...emptyState(), tasks, nextId: tasks.length + 1 });
const bound = (id: string, todoId: number, extra: Partial<AgentView> = {}): AgentView => ({ id, todoId, profile: 'worker', status: 'running', ...extra });
const dismissed = (id: string, todoId: number, status: AgentView['status'] = 'cancelled'): AgentView => ({ ...bound(id, todoId, { status }), taskReportStale: true, dismissed: true });
// ---------------------------------------------------------------------------
// Cleanup shares the exact projection the views use.
// ---------------------------------------------------------------------------

test('clear cleanup consumes latestBoundJobs so a stale newer attempt keeps the task in closed scope', () => {
  const current = state([task(1)]);
  const jobs = [bound('a1', 1, { status: 'failed', reportDelivery: 'delivered' }), dismissed('a2', 1, 'cancelled')];
  const latest = latestBoundJobs(jobs);
  const outcomes = new Map(current.tasks.map((item) => [item.id, taskFilterStatus(item, latest.get(item.id))]));
  assert.equal(outcomes.get(1), 'pending');
  const closed = clearTodoRecords(current, 'closed', new Set(), outcomes, msg);
  assert.deepEqual(closed.state.tasks.map((item) => item.id), [1], 'pending work is not cleaned by the closed scope');
  assert.equal(closed.removedIds.length, 0);

  // The buggy fallback to the older failure would have classified it failed and removed it.
  const buggy = new Map([[1, 'failed']]);
  const removed = clearTodoRecords(current, 'closed', new Set(), buggy, msg);
  assert.deepEqual(removed.state.tasks.map((item) => item.id), []);
});

}


{


test("a child that already reported no longer blocks completing its task", () => {
  const job = { id: "a1", todoId: 5 };
  const none = new Set<string>();
  assert.equal(claimedBy(job, { action: "update", id: 5, status: "completed" }, { adjusted: none, reported: true }), false);
  assert.equal(claimedBy(job, { action: "update", id: 5, status: "completed" }, { adjusted: none, reported: false }), true);
  // Every other change still waits for the child: reopening, editing, deleting, clearing.
  assert.equal(claimedBy(job, { action: "update", id: 5, status: "pending" }, { adjusted: none, reported: true }), true);
  assert.equal(claimedBy(job, { action: "update", id: 5, subject: "改名" }, { adjusted: none, reported: true }), true);
  assert.equal(claimedBy(job, { action: "update", id: 5, status: "completed", subject: "改名" }, { adjusted: none, reported: true }), true, 'completion cannot smuggle a content edit past the guard');
  assert.equal(claimedBy(job, { action: "update", id: 5, status: "completed", addBlockedBy: [3] }, { adjusted: none, reported: true }), true);
  assert.equal(claimedBy(job, { action: "update", id: 5, subject: "改名" }, { adjusted: new Set(["a1"]), reported: false }), false);
  assert.equal(claimedBy(job, { action: "delete", id: 5 }, { adjusted: none, reported: true }), true);
  assert.equal(claimedBy(job, { action: "clear" }, { adjusted: none, reported: true }), true);
  // Read-only actions never reach this guard, but the predicate stays conservative if they do.
  assert.equal(claimedBy(job, { action: "list" }, { adjusted: none, reported: false }), true);
});
}

test('ticket06 the display panel owns icon style, language, model width and four independent widget switches', async t => {
  const host = await protocolHost({ features: ['todos', 'plan', 'goal', 'agents', 'retry'], language: 'zh-CN' });
  t.after(() => host.close());
  const configPath = join(host.directory, 'pi-dag-workflow-config.json');
  await writeFile(configPath, JSON.stringify({ language: 'auto', custom: { keep: ['value'] } }));
  host.ctx.hasUI = true; host.ctx.mode = 'tui';
  host.ctx.ui.theme = { style: (text: string) => text, fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const panels = recordPanels(host.ctx), opening = host.commands.get('dag-display').handler('', host.ctx);
  await panels.wait(() => panels.live() === 1);
  const frame = () => panels.frame().join('\n');
  const config = async () => JSON.parse(await readFile(configPath, 'utf8'));
  assert.match(panels.frame()[0]!, /Display/);
  for (const label of ['图标风格', '语言', '模型名最大宽度', 'Todos 小组件', 'Plan 小组件', 'Goal 小组件', 'Agents 小组件', 'Retry 小组件']) assert.match(frame(), new RegExp(label));
  // Icon style applies on the next render of the same panel (positive control first: nerd has glyphs).
  const privateUse = /[\u{f0000}-\u{ffffd}]/u;
  assert.match(frame(), privateUse, 'Nerd Font is the default rendering');
  await panels.focus('图标风格'); await panels.press('\r');
  await panels.wait(() => frame().includes('纯文本') && !privateUse.test(frame()));
  assert.equal((await config()).iconStyle, 'plain', 'the style is written to the config');
  assert.deepEqual((await config()).custom, { keep: ['value'] }, 'other keys keep their values');
  // Language cycles and is persisted.
  const language = (await config()).language;
  await panels.focus('语言');
  await panels.press('\r');
  for (let attempt = 0; attempt < 50; attempt++) { if ((await config()).language !== language) break; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.notEqual((await config()).language, language);
  // Model width edits through the inline input and lands in the config.
  await panels.focus('模型名最大宽度'); await panels.press('\r'); await panels.press('\x01'); await panels.press('\x0b'); await panels.press('6'); await panels.press('\r');
  for (let attempt = 0; attempt < 50; attempt++) { if ((await config()).modelLabelWidth === 6) break; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal((await config()).modelLabelWidth, 6);
  // Each widget switch flips only its own row.
  const rowValue = (label: string) => frame().split('\n').find(line => line.includes(label)) ?? '';
  await panels.focus('Todos 小组件'); await panels.press('\r');
  await panels.wait(() => /Todos 小组件.*关闭/.test(frame()));
  assert.match(rowValue('Plan 小组件'), /开启/); assert.match(rowValue('Retry 小组件'), /开启/);
  await panels.focus('Retry 小组件'); await panels.press('\r');
  await panels.wait(() => /Retry 小组件.*关闭/.test(frame()));
  assert.match(rowValue('Goal 小组件'), /开启/); assert.match(rowValue('Todos 小组件'), /关闭/);
  // Each widget row names its own module's business: one generic sentence would be wrong for four of five.
  assert.doesNotMatch(frame(), /不影响任务、Goal 或子进程/, 'the old generic sentence is gone');
  const notes: [string, RegExp][] = [['Todos 小组件', /任务清单/], ['Plan 小组件', /Plan 模式/], ['Goal 小组件', /目标焦点/], ['Agents 小组件', /子进程的派发/], ['Retry 小组件', /Retry 的开关/]];
  for (const [label, pattern] of notes) { await panels.focus(label); assert.match(frame(), pattern, `${label} explains its own module`); }
  assert.doesNotMatch(frame(), /Team 小组件/, 'Team has no widget, so no row offers one');
  // The Todos view, filter and tree style are the same state the `todo` command owns, and the widget renders it.
  // The lower zone scrolls, so each row is reached before it is read.
  for (const label of ['Todos 视图', 'Todos 筛选', 'Todos 树样式']) { await panels.focus(label); assert.match(frame(), new RegExp(label)); }
  const widget = () => (host.widgets.get('pi-dag-workflow.todos') ?? []).join('\n');
  // The cursor stays on the row it changed, so the focused line is what the panel now shows.
  const selected = () => panels.frame().find(line => /^[ │]*> /.test(line)) ?? '';
  await panels.focus('Todos 视图');
  await panels.press('\r');
  await panels.wait(() => /依赖图/.test(selected()));
  assert.equal(host.state().view, 'dag', 'the Display row commits the workflow state the command uses');
  assert.equal(host.state().visible, false, 'changing the view does not turn a hidden widget back on');
  await panels.focus('Todos 小组件'); await panels.press('\r');
  await panels.wait(() => host.state().visible);
  // A task makes the widget draw a header; while a panel is open the widget is deliberately hidden, so the
  // view is read from the real widget after the panel closes.
  await host.execute('todo', { action: 'create', subject: '视图回归任务' });
  await panels.press('\x1b'); await opening;
  await panels.wait(() => /Todos.*DAG/.test(widget()));
  // The command and the panel are two views of one state: the command's value shows up in the panel.
  await host.commands.get('todos').handler('view list pending', host.ctx);
  const reopened = host.commands.get('dag-display').handler('', host.ctx);
  await panels.wait(() => panels.live() === 1);
  await panels.focus('Todos 视图'); assert.match(selected(), /列表/, 'the panel reads the command\'s view');
  await panels.focus('Todos 筛选'); assert.match(selected(), /待执行/, 'and the command\'s filter');
  await panels.focus('Todos 树样式'); await panels.press('\r');
  await panels.wait(() => /平铺/.test(selected()));
  assert.equal(host.state().treeStyle, 'flat', 'the tree style is committed, not kept beside the state');
  await panels.press('\x1b'); await reopened;
  await host.commands.get('todos').handler('hide', host.ctx);
  const savedTasks = JSON.stringify(host.state().tasks), nextId = host.state().nextId;
  const hidden = host.commands.get('dag-display').handler('', host.ctx);
  await panels.wait(() => panels.live() === 1);
  try {
    for (const [label, field] of [['Todos 视图', 'view'], ['Todos 筛选', 'filter'], ['Todos 树样式', 'treeStyle']] as const) {
      const previous = host.state()[field];
      await panels.focus(label); await panels.press('\r');
      await panels.wait(() => host.state()[field] !== previous);
      assert.equal(host.state().visible, false, `${label} preserves the explicit hide setting`);
      assert.equal(JSON.stringify(host.state().tasks), savedTasks);
      assert.equal(host.state().nextId, nextId);
    }
  } finally { await panels.press('\x1b'); await hidden; }
  assert.equal(panels.live(), 0);
  // A malformed config is refused without touching the file.
  await writeFile(configPath, '{ broken');
  const second = host.commands.get('dag-display').handler('', host.ctx);
  await panels.wait(() => panels.live() === 1);
  await writeFile(configPath, '{ broken');
  await panels.focus('图标风格'); await panels.press('\r');
  await panels.wait(() => host.notifications.some(message => message.includes('Unexpected') || message.includes('JSON')));
  assert.equal(await readFile(configPath, 'utf8'), '{ broken');
  await panels.press('\x1b'); await second;
});

test('ticket06 the real workflow assembly shows the Display tab only with an enabled module', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dag-tabs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = new Map<string, Function[]>(), commands = new Map<string, any>();
  const pi: any = {
    on(name: string, fn: Function) { events.set(name, [...events.get(name) ?? [], fn]); return () => {}; },
    registerTool() {}, registerCommand(name: string, command: any) { commands.set(name, command); },
    registerFlag() {}, getFlag() {}, appendEntry() {}, sendMessage() {}, sendUserMessage() {},
    getActiveTools: () => ['read'], getAllTools: () => [], setActiveTools() {},
    events: { emit() {}, on() { return () => {}; } },
  };
  const ctx: any = { cwd: root, hasUI: true, mode: 'tui', isIdle: () => true,
    ui: { notify() {}, setWidget() {}, theme: { style: (text: string) => text } },
    sessionManager: { getBranch: () => [], getSessionFile: () => undefined, getLeafId: () => undefined },
    modelRegistry: { find: () => undefined } };
  const { createWorkflow } = await import('../src/workflow/index.ts');
  const workflow = createWorkflow(pi);
  await workflow.attach('todos', pi);
  const panels = recordPanels(ctx);
  // No session_start yet: the Display panel is registered but no module is enabled.
  const cold = commands.get('todos').handler('', ctx);
  // tabs() is not exposed, so the gate is pinned as exact source text; the behaviour below covers the
  // "enabled module adds Display" half through the real registry.
  const workflowSource = readFileSync(new URL('../src/workflow/index.ts', import.meta.url), 'utf8');
  assert.match(workflowSource, /id === 'display' \? anyModule\(\) : modules\[id as Feature\] === true/, 'Display is gated on anyModule()');
  await cold.catch(() => {});
  for (const handler of events.get('session_start') ?? []) await handler({}, ctx);
  const warm = commands.get('todos').handler('', ctx);
  await panels.wait(() => panels.live() === 1);
  assert.match(panels.frame()[0]!, /Display/, 'an enabled module adds the Display tab');
  await panels.press('\x1b'); await warm;
});

test('ticket06 business panels and the resident widget follow the live icon style', async t => {
  const privateUse = /[\u{f0000}-\u{ffffd}]/u;
  const state = { ...emptyState(), visible: true, tasks: [{ id: 1, subject: 'style probe', status: 'pending' as const, blockedBy: [] }], nextId: 2 };
  const styleHost = async (iconStyle: 'plain' | 'nerd-font', mode: 'tui' | 'rpc') => {
    const root = await mkdtemp(join(tmpdir(), `dag-style-${iconStyle}-${mode}-`));
    const directory = join(root, 'agent', 'pi-dag-workflow');
    await (await import('node:fs/promises')).mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'pi-dag-workflow-config.json'), JSON.stringify({ language: 'zh-CN', iconStyle }));
    const host = await protocolHost({ root, features: ['todos', 'retry'], language: 'zh-CN', entries: [{ type: 'custom', customType: STATE_TYPE, data: state }] });
    t.after(() => host.close());
    host.ctx.hasUI = true; host.ctx.mode = mode; host.ctx.ui.theme = { style: (text: string) => text, fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const widgets: string[] = [];
    host.ctx.ui.setWidget = (id: string, widget: any) => {
      if (id !== 'pi-dag-workflow.todos' || !widget) return;
      const lines: string[] = typeof widget === 'function' ? widget({ terminal: { rows: 36, columns: 100 } }).render(100) : widget;
      widgets.push(lines.join('\n'));
    };
    return { host, widgets };
  };
  // Business panel: the style reaches panels.module(..., () => display.iconStyle).
  for (const [iconStyle, expected] of [['plain', false], ['nerd-font', true]] as const) {
    const { host } = await styleHost(iconStyle, 'tui');
    const panels = recordPanels(host.ctx);
    const opening = host.commands.get('todos').handler('', host.ctx);
    await panels.wait(() => panels.live() === 1);
    assert.equal(privateUse.test(panels.frame().join('\n')), expected, `business panel ${iconStyle} glyphs`);
    await panels.press('\x1b'); await opening;
  }
  // Resident widget: createWorkflowView's hooks.iconStyle lands on the retry line.
  for (const [iconStyle, expected] of [['plain', false], ['nerd-font', true]] as const) {
    const { host, widgets } = await styleHost(iconStyle, 'rpc');
    await host.commands.get('retry').handler('on', host.ctx);
    await new Promise(resolve => setTimeout(resolve, 100));
    const retryLine = (widgets.at(-1) ?? '').split('\n').find(line => line.includes('Retry')) ?? '';
    assert.ok(retryLine.length > 0, `the widget painted a Retry line: ${widgets.at(-1)}`);
    assert.equal(privateUse.test(retryLine), expected, `widget retry ${iconStyle} glyphs: ${retryLine}`);
  }
});

test('ticket07 five numeric settings edit in place and persist through the shared config writer', async t => {
  const configOf = (host: any) => join(host.directory, 'pi-dag-workflow-config.json');
  const setup = async (features: any[], seed: object = { language: 'zh-CN' }) => {
    const host = await protocolHost({ features, language: 'zh-CN' });
    t.after(() => host.close());
    await writeFile(configOf(host), JSON.stringify(seed));
    host.ctx.hasUI = true; host.ctx.mode = 'tui';
    host.ctx.ui.theme = { style: (text: string) => text, fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const panels = recordPanels(host.ctx);
    return { host, panels, config: async () => JSON.parse(await readFile(configOf(host), 'utf8')) };
  };
  const selectedRow = (panels: any, word: string) => panels.frame().find((line: string) => /^[ │]*> /.test(line) && line.includes(word));
  const focusRow = async (panels: any, word: string) => {
    for (const key of ['j', 'k']) for (let step = 0; step < 80; step++) {
      if (selectedRow(panels, word)) return;
      await panels.press(key);
    }
    throw new Error(`row not found: ${word}`);
  };
  const editOnce = async (command: string, label: string, value: string, read: (config: any) => unknown, expected: unknown) => {
    const { host, panels, config } = await setup(command === 'plan' ? ['todos', 'plan'] : ['todos', 'goal']);
    const opening = host.commands.get(command).handler('', host.ctx);
    await panels.wait(() => panels.live() === 1);
    if (command === 'goal') { await focusRow(panels, '默认设置'); await panels.press('l'); }
    await focusRow(panels, label);
    await panels.press('\r'); await panels.press('\x01'); await panels.press('\x0b');
    if (value) await panels.press(value);
    await panels.press('\r');
    for (let attempt = 0; attempt < 100; attempt++) { if (JSON.stringify(read(await config())) === JSON.stringify(expected)) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.deepEqual(read(await config()), expected, `${label} is persisted`);
    void opening;
  };
  await editOnce('goal', '默认续跑轮数', '42', c => c.goalMaxTurns, 42);
  await editOnce('goal', '无进展上限', '12', c => c.goalNoProgressLimit, 12);
  await editOnce('goal', '错误重试次数', '3', c => c.goalErrorRetries, 3);
  await editOnce('goal', '自主模式禁止工具', 'ask_user_question, bash', c => c.goalNoPauseTools, ['ask_user_question', 'bash']);
  await editOnce('plan', '编辑配置文件只读工具', 'read, grep', c => c.planTools, ['read', 'grep']);
  // Invalid number and invalid list item are rejected with the old value kept and an actionable reason.
  for (const [command, label, bad, key] of [
    ['goal', '错误重试次数', '21', 'goalErrorRetries'],
    ['goal', '自主模式禁止工具', 'read,,grep', 'goalNoPauseTools'],
    ['plan', '编辑配置文件只读工具', 'read,,grep', 'planTools'],
  ] as const) {
    const { host, panels, config } = await setup(command === 'plan' ? ['todos', 'plan'] : ['todos', 'goal']);
    const before = await config();
    const opening = host.commands.get(command).handler('', host.ctx);
    await panels.wait(() => panels.live() === 1);
    if (command === 'goal') { await focusRow(panels, '默认设置'); await panels.press('l'); }
    await focusRow(panels, label);
    await panels.press('\r'); await panels.press('\x01'); await panels.press('\x0b'); await panels.press(bad); await panels.press('\r');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(await config(), before, `${key} keeps the old value on invalid input`);
    assert.match(panels.frame().join('\n'), /整数|工具名需为/);
    void opening;
  }
  // Ownership: Goal and Plan each show only their own settings; Display shows none of the five.
  const goalHost = await setup(['todos', 'goal']);
  const goalOpening = goalHost.host.commands.get('goal').handler('', goalHost.host.ctx);
  await goalHost.panels.wait(() => goalHost.panels.live() === 1);
  assert.doesNotMatch(goalHost.panels.frame().join('\n'), /编辑配置文件只读工具|planTools/);
  const planHost = await setup(['todos', 'plan']);
  const planOpening = planHost.host.commands.get('plan').handler('', planHost.host.ctx);
  await planHost.panels.wait(() => planHost.panels.live() === 1);
  assert.doesNotMatch(planHost.panels.frame().join('\n'), /默认续跑轮数|无进展上限|错误重试次数|自主模式禁止工具/);
  const displayHost = await setup(['todos', 'goal', 'plan']);
  const displayOpening = displayHost.host.commands.get('dag-display').handler('', displayHost.host.ctx);
  await displayHost.panels.wait(() => displayHost.panels.live() === 1);
  assert.doesNotMatch(displayHost.panels.frame().join('\n'), /默认续跑轮数|无进展上限|错误重试次数|自主模式禁止工具|编辑配置文件只读工具|planTools/);
  // Global defaults remain independent of an existing goal's nolimit setting.
  const limited = await setup(['todos', 'goal']);
  await limited.host.call('goal', { action: 'create', title: 'unlimited probe' });
  await limited.host.commands.get('goal').handler('nolimit #1 on', limited.host.ctx);
  const limitedOpening = limited.host.commands.get('goal').handler('', limited.host.ctx);
  await limited.panels.wait(() => limited.panels.live() === 1);
  await limited.panels.focus('默认设置'); await limited.panels.press('l');
  await limited.panels.focus('默认续跑轮数');
  assert.match(limited.panels.frame().join('\n'), /默认续跑轮数/);
  void goalOpening; void planOpening; void displayOpening; void limitedOpening;
});
