import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from 'typebox/value';
import { applyTodo, emptyState, type TodoParams, type WorkflowState } from '../src/todos/state.ts';
import { registerTodos } from '../src/todos/register.ts';
import { registerAgents } from '../src/agents/register.ts';
import { PresetStore } from '../src/todos/presets.ts';
import { configPaths } from '../src/shared/config.ts';

const presetConfig = {
  presets: [
    { name: 'alpha', description: 'First fragment', steps: [{ key: 'one', subject: '第一步' }, { key: 'two', subject: '第二步', after: ['one'] }] },
    { name: 'beta', steps: [{ key: 'only', subject: 'Only step' }] },
  ],
};

/** The real todo tool wired to the real applyTodo and a live PresetStore, like the runtime does. */
function todoHost() {
  const state = emptyState();
  let store = new PresetStore();
  let writes = 0;
  let tool: any;
  const pi: any = { on() {}, registerCommand() {}, registerTool(value: any) { tool = value; } };
  registerTodos(pi, {
    state: () => state,
    protected: () => false,
    commit() { writes++; },
    reset() {},
    async show() {},
    async refreshPresets() { store = new PresetStore({ path: configPaths().preset }); await store.load(); },
    presets: () => store.list(),
    mutate(params: TodoParams) { const result = applyTodo(state, params, undefined, store); if (result.state !== state) writes++; return result; },
  });
  return { state, tool, writes: () => writes };
}

/** The real agent tools; session_start builds the runtime and ProfileStore against the temp agent dir. */
function agentsHost(state: WorkflowState) {
  const events = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const appended: unknown[] = [];
  const pi: any = {
    on(name: string, handler: Function) { events.set(name, [...(events.get(name) ?? []), handler]); },
    registerTool(value: any) { tools.set(value.name, value); },
    registerFlag() {}, registerCommand() {}, getFlag() {},
    appendEntry(_type: string, data: unknown) { appended.push(data); },
    getThinkingLevel() { return 'off'; }, getActiveTools() { return ['read']; },
  };
  const model = { provider: 'test', id: 'scripted' };
  const ctx: any = { cwd: process.cwd(), hasUI: false, isIdle: () => true, model, modelRegistry: { find: () => model }, sessionManager: { getBranch: () => [] }, ui: { notify() {} } };
  registerAgents(pi, { state: () => state, mutate() {}, paint() {}, protected: () => false });
  return {
    tools, appended, ctx,
    async start() { for (const handler of events.get('session_start') ?? []) await handler({}, ctx); },
    async stop() { for (const handler of events.get('session_shutdown') ?? []) await handler({}, ctx); },
  };
}

async function withAgentDir(t: { after(fn: () => unknown): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dag-catalog-'));
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'pi-dag-workflow'), { recursive: true });
  return root;
}

test('todo presets is a read-only catalog: summaries, one full definition, no state write', async (t) => {
  const root = await withAgentDir(t);
  await writeFile(join(root, 'pi-dag-workflow', 'pi-dag-workflow-preset.json'), JSON.stringify(presetConfig), 'utf8');
  const host = todoHost();
  const tool = host.tool;
  assert.equal(Value.Check(tool.parameters, { action: 'presets' }), true);
  assert.equal(Value.Check(tool.parameters, { action: 'presets', preset: 'alpha' }), true);
  assert.equal(Value.Check(tool.parameters, { action: 'presets', nope: true }), false);
  const extra = await tool.execute('c0', { action: 'presets', description: 'nope' } as any, undefined, undefined, {});
  assert.equal(extra.isError, true, 'presets rejects fields outside preset');

  const listing = await tool.execute('c1', { action: 'presets' }, undefined, undefined, {});
  assert.ok(!listing.isError, JSON.stringify(listing));
  assert.deepEqual(listing.details, { version: 2, action: 'presets', presets: [{ name: 'alpha', description: 'First fragment', steps: 2 }, { name: 'beta', steps: 1 }] });
  assert.equal('tasks' in listing.details, false);
  assert.equal('nextId' in listing.details, false);
  assert.match(listing.content[0]!.text, /First fragment/);
  assert.doesNotMatch(listing.content[0]!.text, /第一步|第二步/);

  const one = await tool.execute('c2', { action: 'presets', preset: 'alpha' }, undefined, undefined, {});
  assert.ok(!one.isError, JSON.stringify(one));
  assert.equal(one.details.preset.name, 'alpha');
  assert.equal(one.details.preset.description, 'First fragment');
  assert.deepEqual(one.details.preset.steps.map((step: any) => step.key), ['one', 'two']);
  assert.deepEqual(JSON.parse(one.content[0]!.text).steps.map((step: any) => step.key), ['one', 'two']);

  const missing = await tool.execute('c3', { action: 'presets', preset: 'missing' }, undefined, undefined, {});
  assert.equal(missing.isError, true);
  assert.match(missing.content[0]!.text, /未找到片段 missing/);
  assert.equal(host.writes(), 0, 'catalog discovery never commits state');

  // apply/reset keep working from the same freshly loaded store.
  const applied = await tool.execute('c4', { action: 'apply', preset: 'beta' }, undefined, undefined, {});
  assert.ok(!applied.isError, JSON.stringify(applied));
  assert.equal(host.writes(), 1);
});

test('subagent_inspect hides profiles by default and only the chosen query returns full instructions', async (t) => {
  const root = await withAgentDir(t);
  const long = 'PROFILE-LONG-INSTRUCTIONS '.repeat(30);
  await writeFile(join(root, 'pi-dag-workflow', 'pi-dag-workflow-profile.json'), JSON.stringify({ profiles: [{ name: 'probe', thinking: 'off', tools: ['read'], instructions: long }] }), 'utf8');
  const host = agentsHost(emptyState());
  await host.start();
  t.after(() => host.stop());
  const inspect = host.tools.get('subagent_inspect');

  assert.equal(Value.Check(inspect.parameters, { profiles: 'summary' }), true);
  assert.equal(Value.Check(inspect.parameters, { profile: 'probe' }), true);
  assert.equal(Value.Check(inspect.parameters, { profiles: 'nope' }), false);

  const plain = await inspect.execute('i1', {}, undefined, undefined, host.ctx);
  assert.deepEqual(Object.keys(plain.details).sort(), ['jobs', 'paused']);
  assert.equal(Object.hasOwn(plain.details, 'profiles'), false);
  assert.doesNotMatch(JSON.stringify(plain.details), /PROFILE-LONG-INSTRUCTIONS/);

  const summary = await inspect.execute('i2', { profiles: 'summary' }, undefined, undefined, host.ctx);
  assert.equal(summary.details.profiles[0].name, 'probe');
  assert.equal(summary.details.profiles[0].instructions, undefined);
  assert.deepEqual(summary.details.profiles[0].tools, ['read']);
  assert.equal(summary.details.profiles[0].thinking, 'off');
  assert.equal(summary.details.profilePath, undefined, 'summary stays minimal');
  assert.doesNotMatch(JSON.stringify(summary.details), /PROFILE-LONG-INSTRUCTIONS/);

  const full = await inspect.execute('i3', { profiles: true }, undefined, undefined, host.ctx);
  assert.match(full.details.profiles[0].instructions, /PROFILE-LONG-INSTRUCTIONS/);
  assert.ok(full.details.profilePath);

  const one = await inspect.execute('i4', { profile: 'probe' }, undefined, undefined, host.ctx);
  assert.match(one.details.profile.instructions, /PROFILE-LONG-INSTRUCTIONS/);
  assert.equal(Object.hasOwn(one.details, 'profiles'), false);

  const missing = await inspect.execute('i5', { profile: 'nope' }, undefined, undefined, host.ctx);
  assert.equal(missing.isError, true);
  assert.match(missing.content[0]!.text, /未找到 Profile nope/);

  const ambiguous = await inspect.execute('i6', { profile: 'probe', profiles: 'summary' }, undefined, undefined, host.ctx);
  assert.equal(ambiguous.isError, true);

  assert.deepEqual(host.appended, [], 'inspection appends no session entries');
});
