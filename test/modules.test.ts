import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { FEATURE_NAMES, type Feature } from '../src/workflow/features.ts';
const packagePath = fileURLToPath(new URL('../', import.meta.url));
const provider = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
const selection = (modules: Feature[]) => ({ packages: [{ source: packagePath, extensions: FEATURE_NAMES.map((name) => `${modules.includes(name) ? '+' : '-'}src/${name}/index.ts`), skills: [], prompts: [], themes: [] }], extensions: ['-builtin:mcp', '-builtin:llama.cpp', '-builtin:codemode', '-builtin:tool-search'] });
async function configure(root: string, modules: Feature[]) {
  await mkdir(join(root, 'agent'), { recursive: true });
  await writeFile(join(root, 'agent', 'settings.json'), JSON.stringify(selection(modules)));
}
async function start(modules: Feature[], extras: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'dag-modules-'));
  await configure(root, modules);
  return IsolatedClient.start(root, 'selected', extras, modules.includes('agents') ? ['--dag-workflow-test-child-provider', provider] : [], true);
}
async function call(client: IsolatedClient, name: string, args: object) {
  const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(args)}`);
  const event = events.find((item) => item.type === 'tool_execution_end' && item.toolName === name)!; assert.ok(event);
  return { ...event.result as any, isError: event.isError === true || (event.result as any)?.isError === true };
}
test('native Pi package filters cover all 32 resource combinations with no duplicate tools/commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dag-filter-matrix-'));
  try {
    for (let mask = 0; mask < 32; mask++) {
      const modules = FEATURE_NAMES.filter((_name, i) => Boolean(mask & 1 << i));
      const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'agent'), settingsManager: SettingsManager.inMemory(selection(modules)), noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await loader.reload();
      const result = loader.getExtensions(); assert.deepEqual(result.errors, []);
      assert.equal(result.extensions.length, modules.length);
      const tools = result.extensions.flatMap((item) => [...item.tools.keys()]);
      const commands = result.extensions.flatMap((item) => [...item.commands.keys()]);
      const expected = [...modules.includes('todos') ? ['todo'] : [], ...modules.includes('agents') ? ['subagent_spawn', 'subagent_inspect', 'subagent_send', 'subagent_wait', 'subagent_cancel'] : [], ...modules.includes('goal') ? ['goal'] : []];
      assert.deepEqual(tools.sort(), expected.sort()); assert.equal(new Set(commands).size, commands.length);
      assert.equal(commands.includes('plan'), modules.includes('plan')); assert.equal(commands.includes('dag'), modules.includes('todos'));
      result.runtime.invalidate();
    }
  } finally { await import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })); }
});
test('actual Pi: Todo-only and no UI exclude Goal/Agent/Plan schemas and background widgets', { timeout: 30000 }, async (t) => {
  const client = await start(['todos']); t.after(() => client.close());
  const commands = (await client.send('get_commands')).data as any;
  assert.deepEqual(commands.commands.map((item: any) => item.name).sort(), ['dag', 'todos']);
  assert.equal((await call(client, 'todo', { action: 'create', subject: '只管理任务' })).isError, false);
  assert.ok(!client.records.some((item) => item.method === 'setWidget'));
  const messages = (await client.send('get_messages')).data as any;
  const schemas = messages.messages.filter((item: any) => item.role === 'system').flatMap((item: any) => item.toolsAdded ?? []).map((item: any) => item.name);
  assert.ok(schemas.includes('todo')); assert.ok(!schemas.includes('goal')); assert.ok(!schemas.includes('subagent_spawn'));
});
test('actual Pi: Goal works without Todo/Agent and retains bounded independent research', { timeout: 30000 }, async (t) => {
  const client = await start(['goal', 'ui']); t.after(() => client.close());
  const commands = (await client.send('get_commands')).data as any;
  assert.deepEqual(commands.commands.map((item: any) => item.name), ['goal']);
  await call(client, 'goal', { action: 'create', title: '完成测试', maxTurns: 2 }); await call(client, 'goal', { action: 'enable', id: 1 });
  const entries = await client.entries() as any[];
  const goal = entries.findLast((entry) => entry.customType === 'pi-dag-workflow.goal').data;
  assert.equal(goal.goals[0].status, 'completed');
  assert.ok(!entries.some((entry) => entry.customType === 'pi-dag-workflow.state' || entry.customType === 'pi-dag-workflow.agents'));
});
test('actual Pi: standalone Agents spawn/return without Goal gates or Todo links', { timeout: 30000 }, async (t) => {
  const client = await start(['agents']); t.after(() => client.close());
  const job = await call(client, 'subagent_spawn', { task: '独立只读调查' });
  assert.equal(job.isError, false);
  const result = await call(client, 'subagent_wait', { jobId: job.details.jobId, timeout: 10 });
  assert.equal(result.details.status, 'completed');
  assert.equal((await call(client, 'subagent_spawn', { task: '不允许关联未启用任务', todoId: 1 })).isError, true);
  assert.ok(!client.records.some((item) => item.method === 'setWidget'));
});
test('actual Pi: disabling Plan on reload does not strand old read-only state; Todo history remains', { timeout: 30000 }, async (t) => {
  let client = await start(['todos', 'plan']); t.after(() => client.close());
  await call(client, 'todo', { action: 'create', subject: '保留任务' }); await client.prompt('/plan start');
  await client.close(false);
  await configure(client.root, ['todos']);
  client = await IsolatedClient.start(client.root, 'selected', [], [], true);
  assert.equal((await call(client, 'todo', { action: 'update', id: 1, status: 'completed' })).isError, false);
  const entries = await client.entries() as any[];
  assert.equal(entries.findLast((entry) => entry.customType === 'pi-dag-workflow.state').data.tasks[0].subject, '保留任务');
});
test('actual Pi: Plan-only guards implementation without task tools', { timeout: 30000 }, async (t) => {
  const client = await start(['plan']); t.after(() => client.close());
  const commands = (await client.send('get_commands')).data as any;
  assert.deepEqual(commands.commands.map((item: any) => item.name), ['plan']);
  await client.prompt('/plan start');
  assert.equal((await call(client, 'write', { path: 'blocked.txt', content: 'no' })).isError, true);
  await client.prompt('/plan off');
  assert.equal((await call(client, 'write', { path: 'allowed.txt', content: 'yes' })).isError, false);
});
test('actual Pi: disabled Todo history cannot block an independent Goal', { timeout: 30000 }, async (t) => {
  const controls = fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url));
  const client = await start(['goal'], [controls]); t.after(() => client.close());
  await client.prompt('/test-corrupt'); await client.prompt('/test-reload');
  assert.equal((await call(client, 'goal', { action: 'create', title: '无任务状态的目标' })).isError, false);
  const messages = (await client.send('get_messages')).data as any;
  const schemas = messages.messages.filter((item: any) => item.role === 'system').flatMap((item: any) => item.toolsAdded ?? []).map((item: any) => item.name);
  assert.ok(!schemas.includes('todo')); assert.ok(schemas.includes('goal'));
});
test('actual Pi: reload applies Pi resource toggles and creates a fresh coordinator', { timeout: 30000 }, async (t) => {
  const controls = fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url));
  const client = await start(['todos', 'plan', 'ui'], [controls]); t.after(() => client.close());
  await call(client, 'todo', { action: 'create', subject: '重载保留' }); await client.prompt('/plan start');
  await configure(client.root, ['todos']); await client.prompt('/test-reload');
  const commands = ((await client.send('get_commands')).data as any).commands.map((item: any) => item.name);
  assert.ok(!commands.includes('plan')); assert.ok(commands.includes('todos'));
  assert.equal((await call(client, 'todo', { action: 'update', id: 1, status: 'completed' })).isError, false);
  const mark = client.records.length;
  await call(client, 'todo', { action: 'create', subject: '无 UI 的新任务' });
  assert.ok(!client.records.slice(mark).some((item) => item.method === 'setWidget'));
});
test('actual Pi: reverse factory order retains Todo links, Plan guard and shared Goal/Agent state', { timeout: 30000 }, async (t) => {
  const entries = [...FEATURE_NAMES].reverse().map((name) => join(packagePath, `src/${name}/index.ts`));
  const client = await IsolatedClient.start(undefined, 'reverse', [], ['--dag-workflow-test-child-provider', provider], false, entries); t.after(() => client.close());
  await call(client, 'todo', { action: 'create', subject: '反序派发' });
  const job = await call(client, 'subagent_spawn', { task: '反序独立调查', todoId: 1 }); assert.equal(job.isError, false);
  assert.equal((await call(client, 'subagent_wait', { jobId: job.details.jobId, timeout: 10 })).details.status, 'completed');
  await client.prompt('/plan start'); assert.equal((await call(client, 'write', { path: 'blocked', content: 'no' })).isError, true);
  await client.prompt('/plan off'); assert.equal((await call(client, 'goal', { action: 'create', title: '反序目标' })).isError, false);
});
test('actual Pi: project trust can filter preloaded personal resources without phantom modules', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-project-filter-'));
  await configure(root, [...FEATURE_NAMES]); await mkdir(join(root, '.pi'), { recursive: true });
  const project = selection(['goal', 'ui']);
  await writeFile(join(root, '.pi', 'settings.json'), JSON.stringify({ packages: project.packages.map((item) => ({ ...item, autoload: false })) }));
  const controls = fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url));
  const client = await IsolatedClient.start(root, 'project', [controls], ['--approve'], true); t.after(() => client.close());
  const commands = ((await client.send('get_commands')).data as any).commands.map((item: any) => item.name);
  assert.ok(!commands.includes('todos')); assert.ok(!commands.includes('plan')); assert.ok(!commands.includes('agents'));
  await client.prompt('/test-corrupt'); await client.prompt('/test-reload');
  assert.equal((await call(client, 'goal', { action: 'create', title: '前置信任不产生幽灵 Todo' })).isError, false);
});
test('actual Pi 0.99.2: codemode discovers namespace guidance; nested mutations obey Plan', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-codemode-')); await configure(root, ['todos', 'plan']);
  const client = await IsolatedClient.start(root, 'codemode', ['builtin:codemode'], ['--tools', 'read,write,todo,codemode'], true); t.after(() => client.close());
  const result = await call(client, 'codemode', { code: 'text(await describeNamespace("pi_dag_workflow")); text(await tools.todo({action:"create",subject:"codemode task"}));' });
  assert.equal(result.isError, false); assert.match(JSON.stringify(result.content), /verify work before completing/);
  await client.prompt('/plan tools codemode'); await client.prompt('/plan start');
  const blocked = await call(client, 'codemode', { code: 'await tools.write({path:"forbidden.txt",content:"no"});' });
  assert.equal(blocked.isError, true);
  await import('node:fs/promises').then((fs) => assert.rejects(fs.access(join(root, 'forbidden.txt'))));
  const listed = await call(client, 'codemode', { code: 'text(await tools.todo({action:"list"}));' }); assert.equal(listed.isError, false);
});
test('actual Pi: no modules registers no commands or lifecycle resources', { timeout: 30000 }, async (t) => {
  const client = await start([]); t.after(() => client.close());
  assert.deepEqual(((await client.send('get_commands')).data as any).commands, []);
  await client.prompt('普通对话');
  assert.ok(!client.records.some((item) => item.type === 'entry_appended' || item.method === 'setWidget'));
});
