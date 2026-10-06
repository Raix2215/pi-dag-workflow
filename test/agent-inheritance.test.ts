import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from '../src/agents/runtime.ts';
import { ProfileStore } from '../src/agents/profiles.ts';
import { IsolatedClient } from './fixtures/isolated-client.ts';

const fixture = fileURLToPath(new URL('./fixtures/m2-rpc-fixture.mjs', import.meta.url));
const model = { provider: 'dag-test', id: 'scripted' };

test('runtime captures live parent settings and adjusts only implicit thinking to supported levels', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-inheritance-'));
  const profiles = new ProfileStore({ registry: { find: () => ({ reasoning: true }) }, trustedTools: ['bash', 'write'] });
  let thinking = 'high' as 'high' | 'off'; let tools = ['read', 'write', 'custom_search']; let current = model;
  const runtime = new AgentRuntime({ cwd: root, profiles, getInheritedModel: () => current, getInheritedThinking: () => thinking, getInheritedTools: () => tools, testCliPath: fixture });
  t.after(async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); });
  const first = await runtime.spawn({ task: 'HOLD', profile: 'inherit' });
  assert.equal(first.profile, 'inherit'); assert.equal(first.thinking, 'low'); assert.deepEqual(first.tools, ['read', 'write']);
  thinking = 'off'; tools = ['read']; current = { provider: 'dag-test', id: 'alternate' };
  const second = await runtime.spawn({ task: 'HOLD' });
  assert.equal(second.model.id, 'alternate'); assert.equal(second.thinking, 'off'); assert.deepEqual(second.tools, ['read']);
  assert.equal(runtime.inspect(first.id)[0]!.model.id, 'scripted'); assert.equal(runtime.inspect(first.id)[0]!.thinking, 'low');
  profiles.set({ name: 'explicit', model, thinking: 'high' });
  const rejected = await runtime.spawn({ task: 'HOLD', profile: 'explicit' });
  assert.equal(rejected.status, 'failed'); assert.match((await runtime.wait(rejected.id)).output, /Thinking level high is unsupported/);
});

test('real Pi: default and explicit inherit can implement with active parent built-ins; profiles override them', { timeout: 30000 }, async (t) => {
  const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
  const client = await IsolatedClient.start(undefined, 'inherit-config', [], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  const call = async (name: string, params: object) => {
    const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(params)}`);
    const end = events.find((event) => event.type === 'tool_execution_end' && event.toolName === name)!;
    assert.ok(end); assert.ok(!end.isError && !(end.result as any).isError, JSON.stringify(end.result));
    return (end.result as any).details;
  };
  await client.send('set_model', { provider: 'dag-test', modelId: 'reasoned' });
  await client.send('set_thinking_level', { level: 'high' });
  const captured = await call('subagent_spawn', { task: 'INHERIT SETTINGS SNAPSHOT' });
  const actual = await call('subagent_wait', { jobId: captured.jobId, until: 'finish', timeout: 8 });
  assert.deepEqual(JSON.parse(actual.output.trim()), { model: 'reasoned', thinking: 'high' });
  assert.equal(actual.thinking, 'high');
  const spawn = await call('subagent_spawn', { task: 'TEST CALL write {"path":"inherited-write.txt","content":"implemented"}', profile: 'inherit' });
  const result = await call('subagent_wait', { jobId: spawn.jobId, until: 'finish', timeout: 8 });
  assert.equal(result.profile, 'inherit'); assert.equal(result.thinking, 'high'); assert.ok(result.tools.includes('write'));
  assert.ok(!result.tools.includes('todo') && !result.tools.includes('subagent_spawn'));
  assert.equal(await readFile(join(client.root, 'inherited-write.txt'), 'utf8'), 'implemented');
  const dir = join(client.root, 'agent/pi-dag-workflow'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'pi-dag-workflow-profile.json'), JSON.stringify({ profiles: [{ name: 'reader', thinking: 'off', tools: ['read'] }] }));
  const named = await call('subagent_spawn', { task: 'short read-only assignment', profile: 'reader' });
  const reader = await call('subagent_wait', { jobId: named.jobId, until: 'finish', timeout: 8 });
  assert.deepEqual(reader.tools, ['read']);
  const inspect = await call('subagent_inspect', {});
  assert.equal(inspect.jobs[0].profile, 'inherit'); assert.equal(inspect.jobs[2].profile, 'reader');
  assert.equal(reader.thinking, 'off');
  assert.ok(client.records.some((event) => event.method === 'setWidget' && (event.widgetLines as string[] | undefined)?.some((line) => line.includes('· inherit'))));
});
