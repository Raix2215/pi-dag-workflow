import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from 'typebox/value';
import { applyTodo, emptyState, type TodoParams, type WorkflowState } from '../src/todos/state.ts';
import { registerTodos } from '../src/todos/register.ts';
import { registerAgents } from '../src/agents/register.ts';
import { PresetStore } from '../src/todos/presets.ts';
import { configPaths } from '../src/shared/config.ts';
import { AgentRuntime } from '../src/agents/runtime.ts';
import { THINKING_LEVELS } from '../src/agents/profiles.ts';
import { createTranslator, type Translator } from '../src/shared/i18n.ts';
import { jobSummary, modelSummary, toolDisplay } from '../src/ui/presentation.ts';

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
function agentsHost(state: WorkflowState, msg?: Translator) {
  const events = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const appended: unknown[] = [];
  const pi: any = {
    on(name: string, handler: Function) { events.set(name, [...(events.get(name) ?? []), handler]); },
    registerTool(value: any) { tools.set(value.name, value); },
    registerFlag() {}, registerCommand(name: string, command: any) { commands.set(name, command); }, getFlag() {},
    appendEntry(_type: string, data: unknown) { appended.push(data); },
    getThinkingLevel() { return 'off'; }, getActiveTools() { return ['read']; },
  };
  const model = { provider: 'test', id: 'scripted' };
  const ctx: any = { cwd: process.cwd(), hasUI: false, isIdle: () => true, model, modelRegistry: { find: () => model }, sessionManager: { getBranch: () => [] }, ui: { notify() {} } };
  registerAgents(pi, { state: () => state, mutate() {}, paint() {}, protected: () => false, ...(msg ? { msg } : {}) });
  return {
    tools, commands, appended, ctx,
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

const catalogModel = (provider: string, id: string) => ({ provider, id, name: `Name ${id}`, reasoning: true, contextWindow: 10000, maxTokens: 1000, input: ['text'], baseUrl: 'https://private.invalid', headers: { Authorization: 'SECRET' }, apiKey: 'SECRET' });

test('model discovery is opt-in, paginated, stable and strips private registry fields', async (t) => {
  await withAgentDir(t);
  const host = agentsHost(emptyState());
  let reads = 0;
  const source = Array.from({ length: 25 }, (_, i) => catalogModel(i < 12 ? 'b' : 'a', `model-${String(i).padStart(2, '0')}`)).reverse();
  host.ctx.modelRegistry.getAvailable = () => { reads++; return source; };
  await host.start(); t.after(() => host.stop());
  assert.equal(reads, 0, 'session startup does not enumerate available models');
  assert.deepEqual([...host.tools.keys()], ['subagent_spawn', 'subagent_inspect', 'subagent_send', 'subagent_cancel']);
  const inspect = host.tools.get('subagent_inspect');
  const query = (args: object) => inspect.execute('models', args, undefined, undefined, host.ctx);
  for (const args of [{ models: true }, { models: true, limit: 1, offset: 0 }, { models: true, limit: 100, offset: 30, query: 'name' }]) assert.equal(Value.Check(inspect.parameters, args), true);
  for (const args of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { offset: -1 }, { offset: 0.5 }, { query: false }]) assert.equal(Value.Check(inspect.parameters, { models: true, ...args }), false);
  await query({}); await query({ models: false }); await query({ profiles: 'summary' });
  assert.equal(reads, 0, 'ordinary job/profile queries do not enumerate models');
  for (const field of ['jobId', 'profile', 'profiles', 'output', 'timeout', 'until', 'after']) {
    const value: Record<string, unknown> = { jobId: 'a1', profile: 'probe', profiles: false, output: false, timeout: 0, until: 'update', after: 0 };
    assert.equal((await query({ models: true, [field]: value[field] })).isError, true, field);
  }
  for (const args of [{ query: '' }, { limit: 20 }, { offset: 0 }, { models: false, query: 'a' }]) assert.equal((await query(args)).isError, true);
  assert.equal(reads, 0, 'invalid combinations are rejected before registry access');
  const first = await query({ models: true });
  assert.equal(first.details.models.length, 20); assert.equal(first.details.total, 25); assert.equal(first.details.nextOffset, 20);
  assert.deepEqual(first.details.models.map((model: any) => `${model.provider}/${model.id}`), [...source].sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`)).slice(0, 20).map(model => `${model.provider}/${model.id}`));
  assert.deepEqual(Object.keys(first.details.models[0]).sort(), ['contextWindow', 'id', 'input', 'maxTokens', 'name', 'provider', 'reasoning']);
  assert.doesNotMatch(first.content[0].text, /private|SECRET|baseUrl|headers|apiKey/);
  assert.equal('jobs' in first.details, false); assert.equal('profiles' in first.details, false);
  const last = await query({ models: true, offset: first.details.nextOffset });
  assert.equal(last.details.models.length, 5); assert.equal(last.details.nextOffset, null);
  const beyond = await query({ models: true, offset: 99 }); assert.deepEqual(beyond.details.models, []); assert.equal(beyond.details.nextOffset, null); assert.equal(beyond.details.total, 25);
  const match = await query({ models: true, query: ' NAME MODEL-05 ' });
  assert.equal(match.details.total, 1); assert.equal(match.details.models[0].id, 'model-05');
  const byProvider = await query({ models: true, query: 'B', limit: 2 }); assert.equal(byProvider.details.total, 12); assert.equal(byProvider.details.nextOffset, 2);
  assert.deepEqual((await query({ models: true, query: 'absent' })).details, { models: [], total: 0, nextOffset: null });
  assert.deepEqual(host.appended, []);
});

test('spawn schemas and forwarding preserve explicit overrides and return actual configuration', async (t) => {
  const root = await withAgentDir(t);
  const host = agentsHost(emptyState()); await host.start(); t.after(() => host.stop());
  const spawn = host.tools.get('subagent_spawn');
  const actual = { id: 'a1', status: 'running', model: { provider: 'test', id: 'actual' }, thinking: 'low', tools: ['read'], skills: ['/skills/checked.md'], startedAt: 1, pendingRequests: 0, profile: 'inherit' };
  const forwarded: any[] = [];
  t.mock.method(AgentRuntime.prototype, 'spawn', async (args: any) => { forwarded.push(args); return actual; });
  t.mock.method(AgentRuntime.prototype, 'inspect', () => [actual]);
  for (const thinking of THINKING_LEVELS) assert.equal(Value.Check(spawn.parameters, { task: 'test', thinking }), true);
  for (const args of [{ thinking: 'impossible' }, { model: { id: 'only' } }, { model: { provider: 'test', id: 'm', headers: {} } }, { skills: [1] }, { skills: [''] }]) assert.equal(Value.Check(spawn.parameters, { task: 'test', ...args }), false);
  const explicit = { task: 'test', model: { provider: 'test', id: 'requested' }, thinking: 'high', tools: ['read'], skills: [] };
  assert.equal(Value.Check(spawn.parameters, explicit), true);
  const result = await spawn.execute('spawn', explicit, undefined, undefined, host.ctx);
  assert.equal(result.isError, undefined); assert.deepEqual(forwarded[0], explicit);
  assert.deepEqual(result.details, { jobId: actual.id, status: actual.status, model: actual.model, thinking: actual.thinking, tools: actual.tools, skills: actual.skills });
  await spawn.execute('spawn-default', { task: 'defaults' }, undefined, undefined, host.ctx);
  assert.deepEqual(forwarded[1], { task: 'defaults' }, 'omitted fields stay omitted');
  await spawn.execute('spawn-paths', { task: 'paths', skills: ['skills/probe.md'] }, undefined, undefined, host.ctx);
  assert.deepEqual(forwarded[2], { task: 'paths', skills: ['skills/probe.md'] }, 'paths forwarded without implicit tools/read');
  await writeFile(join(root, 'pi-dag-workflow', 'pi-dag-workflow-profile.json'), '{invalid');
  for (const profile of [undefined, 'inherit']) {
    const args = { task: 'resume', resumeFrom: 'a1', ...(profile ? { profile } : {}) };
    const resumed = await spawn.execute('resume', args, undefined, undefined, host.ctx);
    assert.equal(resumed.isError, undefined, JSON.stringify(resumed)); assert.deepEqual(forwarded.at(-1), args);
  }
  assert.equal((await spawn.execute('named-resume', { task: 'resume', resumeFrom: 'a1', profile: 'changed' }, undefined, undefined, host.ctx)).isError, true, 'explicit named profile still reloads its configuration');
  assert.match(spawn.description, /last actual configuration/); assert.match(spawn.description, /never added implicitly/); assert.match(spawn.description, /not auto-discovered or system prompts/);
});

test('send tools requires recipient + interrupt, and only forwards validated replacements', async (t) => {
  await withAgentDir(t);
  const host = agentsHost(emptyState()); await host.start(); t.after(() => host.stop());
  const forwarded: any[] = [];
  t.mock.method(AgentRuntime.prototype, 'send', async (args: any) => { forwarded.push(args); return { delivery: 'accepted', status: 'running' }; });
  t.mock.method(AgentRuntime.prototype, 'inspect', () => [{ id: 'a1', reportVersion: 2 }]);
  const send = host.tools.get('subagent_send');
  const call = (args: object) => send.execute('send', { message: 'authorized direction', ...args }, undefined, undefined, host.ctx);
  assert.equal(Value.Check(send.parameters, { recipient: 'a1', message: 'change', interrupt: true, tools: ['read'] }), true);
  assert.equal(Value.Check(send.parameters, { recipient: 'a1', message: 'change', interrupt: true, tools: [1] }), false);
  for (const args of [{ recipient: 'a1', tools: [] }, { recipient: 'a1', tools: [], interrupt: false }, { requestId: 'q1', tools: ['read'], interrupt: true }, { recipient: 'a1', requestId: 'q1', tools: ['read'], interrupt: true }]) assert.equal((await call(args)).isError, true);
  assert.equal(forwarded.length, 0);
  assert.equal((await call({ recipient: 'a1', interrupt: true, tools: ['read'] })).isError, undefined);
  assert.deepEqual(forwarded[0], { message: 'authorized direction', recipient: 'a1', interrupt: true, tools: ['read'] });
  await call({ recipient: 'a1' }); assert.equal('tools' in forwarded[1], false);
  await call({ requestId: 'q1' }); assert.deepEqual(forwarded[2], { message: 'authorized direction', requestId: 'q1' });
  assert.match(send.description, /child's request is not authorization/); assert.match(send.description, /not a sandbox/);
});

for (const locale of ['zh-CN', 'en'] as const) test(`native agents model catalog searches/pages and reads exact references without mutations (${locale})`, async (t) => {
  const root = await withAgentDir(t), msg = createTranslator(locale);
  const profilePath = join(root, 'pi-dag-workflow', 'pi-dag-workflow-profile.json');
  const profileBytes = JSON.stringify({ profiles: [{ name: 'unchanged', tools: ['read'] }] }); await writeFile(profilePath, profileBytes);
  const host = agentsHost(emptyState(), msg), beforeModel = structuredClone(host.ctx.model);
  const models = Array.from({ length: 10 }, (_, i) => catalogModel('test', `model-${i}`)); models[9]!.id = 'exact/id/with/slashes';
  let reads = 0; host.ctx.modelRegistry.getAvailable = () => { reads++; return models; };
  host.ctx.hasUI = true; host.ctx.mode = 'rpc';
  const notices: string[] = []; host.ctx.ui.notify = (text: string) => notices.push(text);
  host.ctx.ui.input = async () => 'exact/id/with/slashes';
  let step = 0;
  host.ctx.ui.select = async (title: string, options: string[]) => {
    const pick = (word: string) => { const option = options.find(value => value.includes(word)); assert.ok(option, `${title}: missing ${word}`); return option; };
    switch (++step) {
      case 1: assert.equal(reads, 0); return pick(msg('模型目录'));
      case 2: return pick(msg('下一页'));
      case 3: return pick(msg('搜索…'));
      case 4: assert.equal(options.filter(value => value.startsWith('Name')).length, 1); return pick('Name model-9');
      case 5: return undefined;
      case 6: return undefined;
      default: throw new Error('Unexpected extra menu');
    }
  };
  await host.start(); t.after(() => host.stop());
  await host.commands.get('agents').handler('', host.ctx);
  assert.equal(step, 6); assert.equal(notices.length, 1); assert.match(notices[0]!, /provider: test\nid: exact\/id\/with\/slashes/);
  assert.doesNotMatch(notices[0]!, /SECRET|private|baseUrl|headers/);
  assert.deepEqual(host.ctx.model, beforeModel); assert.equal(await readFile(profilePath, 'utf8'), profileBytes); assert.deepEqual(host.appended, []);
});

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
