import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { registerWorkflow } from '../src/workflow/index.ts';
import { MODULE_NAMES, type Modules, type ModuleName } from '../src/shared/config.ts';
const provider = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
async function start(modules: ModuleName[], extras: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'dag-modules-'));
  await mkdir(join(root, 'agent', 'pi-dag-workflow'), { recursive: true });
  await writeFile(join(root, 'agent', 'pi-dag-workflow', 'pi-dag-workflow-config.json'), JSON.stringify({ modules }));
  return IsolatedClient.start(root, 'selected', extras, modules.includes('agents') ? ['--dag-workflow-test-child-provider', provider] : []);
}
async function call(client: IsolatedClient, name: string, args: object) {
  const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(args)}`);
  const event = events.find((item) => item.type === 'tool_execution_end' && item.toolName === name)!; assert.ok(event);
  return { ...event.result as any, isError: event.isError === true || (event.result as any)?.isError === true };
}
test('registration covers all 32 module combinations with no duplicate tools/commands', () => {
  for (let mask = 0; mask < 32; mask++) {
    const modules = Object.fromEntries(MODULE_NAMES.map((name, i) => [name, Boolean(mask & 1 << i)])) as Modules;
    const tools = new Set<string>(); const commands = new Set<string>();
    const pi: any = { on() {}, registerFlag() {}, registerTool(value: any) { assert.ok(!tools.has(value.name)); tools.add(value.name); }, registerCommand(name: string) { assert.ok(!commands.has(name)); commands.add(name); } };
    registerWorkflow(pi, modules);
    const expected = [...modules.todos ? ['todo'] : [], ...modules.agents ? ['subagent_spawn', 'subagent_inspect', 'subagent_send', 'subagent_wait', 'subagent_cancel'] : [], ...modules.goal ? ['goal'] : []];
    assert.deepEqual([...tools], expected);
    assert.equal(commands.has('plan'), modules.plan);
    assert.equal(commands.has('dag'), modules.todos);
  }
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
  await writeFile(join(client.root, 'agent', 'pi-dag-workflow', 'pi-dag-workflow-config.json'), JSON.stringify({ modules: ['todos'] }));
  client = await IsolatedClient.start(client.root, 'selected');
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
test('actual Pi: no modules registers no commands or lifecycle resources', { timeout: 30000 }, async (t) => {
  const client = await start([]); t.after(() => client.close());
  assert.deepEqual(((await client.send('get_commands')).data as any).commands, []);
  await client.prompt('普通对话');
  assert.ok(!client.records.some((item) => item.type === 'entry_appended' || item.method === 'setWidget'));
});
