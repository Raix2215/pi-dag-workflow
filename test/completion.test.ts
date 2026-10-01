import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { completeArguments, safeCompletionText, tokenMatches, type CompletionSpec } from '../src/shared/completion.ts';
import { emptyState, type WorkflowState } from '../src/todos/state.ts';
import { GOAL_TYPE, type GoalState } from '../src/goal/state.ts';
import { registerTodos } from '../src/todos/register.ts';
import { registerPlan } from '../src/plan/register.ts';
import { registerGoal } from '../src/goal/register.ts';
import { registerAgents } from '../src/agents/register.ts';

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
  assert.deepEqual(values(completeArguments('start', spec)), ['start']);

  // view second level completes with the full argument prefix.
  assert.deepEqual(values(completeArguments('view ', spec)), ['view list', 'view dag']);
  assert.deepEqual(values(completeArguments('view d', spec)), ['view dag']);
  assert.equal(completeArguments('view list ', spec), null);

  // Ids: trailing space lists valid ids and the value keeps the whole argument prefix.
  assert.deepEqual(values(completeArguments('start ', spec)), ['start #41']);
  assert.deepEqual(values(completeArguments('start #4', spec)), ['start #41']);
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
  assert.deepEqual(values(await todos('')), ['add', 'start', 'done', 'pending', 'delete', 'edit', 'list', 'view', 'paths', 'flat', 'show', 'hide', 'clear', 'help']);
  assert.deepEqual(values(await todos('view ')), ['view list', 'view dag']);
  assert.deepEqual(values(await todos('start ')), ['start #41', 'start #43']);
  assert.deepEqual(values(await todos('delete ')), ['delete #41', 'delete #42', 'delete #43']);
  assert.deepEqual(values(await todos('edit #4')), ['edit #41', 'edit #42', 'edit #43']);
  assert.equal(await todos('add '), null);
  assert.equal(await todos('nope '), null);

  const plan = commands.get('plan').getArgumentCompletions;
  assert.equal(typeof plan, 'function');
  assert.deepEqual(values(await plan('')), ['start', 'off', 'status', 'tools', 'help']);

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
  // One spelling per operation: retired synonyms never come back as candidates.
  assert.deepEqual(values(await goal('')), ['new', 'list', 'enable', 'disable', 'complete', 'delete', 'edit', 'get', 'config', 'reset', 'help']);
  assert.deepEqual(values(await goal('enable ')), ['enable #1']);
  assert.deepEqual(values(await goal('delete ')), ['delete #1', 'delete #2']);
  assert.equal(await goal('new '), null);

  // Registering and completing performed no mutations or session writes of its own.
  assert.deepEqual(appended, []);
});

test('registered /agents exposes completions without a running runtime', async () => {
  const { pi, commands } = fakePi();
  registerAgents(pi, { state: () => emptyState(), mutate: () => {}, paint: () => {}, protected: () => false });
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
